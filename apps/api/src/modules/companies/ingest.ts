import { createHash } from "node:crypto";
import {
  companies,
  companySites,
  contactPointSites,
  contactPoints,
  type DbExecutor,
  dataProvenance,
  searchRunResults,
  sourceRecords,
} from "@icmspy/db";
import { and, eq, or, sql } from "drizzle-orm";
import { findSuppressed, type SuppressionCandidate } from "../compliance";
import type { RawRecord, ResolvedContact, ResolvedRecord } from "../discovery";
import { isRoleAddress } from "../enrichment/normalize";

export interface IngestItem {
  raw: RawRecord;
  resolved: ResolvedRecord;
}

export interface IngestInput {
  sourceId: string;
  searchRunId: string;
  items: IngestItem[];
}

/** Qué cambió en la base. Repetir la misma importación deja todos los "New" en cero. */
export interface IngestStats {
  recordsNew: number;
  recordsUnchanged: number;
  /** Empresas distintas encontradas (nuevas + existentes). */
  companiesMatched: number;
  companiesNew: number;
  companiesExisting: number;
  /** Sedes distintas encontradas. */
  sitesMatched: number;
  sitesNew: number;
  sitesExisting: number;
  contactsNew: number;
  contactsExisting: number;
  contactsSuppressed: number;
  contactsDiscarded: number;
}

const REDACTED = "[suprimido]";

/** JSON con claves ordenadas: el mismo contenido da siempre el mismo hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function suppressionCandidates(contact: ResolvedContact): SuppressionCandidate[] {
  if (!contact.normalized) return [];
  if (contact.kind === "email") {
    const domain = contact.normalized.split("@")[1];
    return [
      { kind: "email", normalizedValue: contact.normalized },
      ...(domain ? [{ kind: "domain" as const, normalizedValue: domain }] : []),
    ];
  }
  if (contact.kind === "phone") return [{ kind: "phone", normalizedValue: contact.normalized }];
  return [];
}

/** Quita del original los valores suprimidos, para no conservar el dato que se pidió olvidar. */
function redact(payload: Record<string, unknown>, values: string[]): Record<string, unknown> {
  if (values.length === 0) return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] =
      typeof value === "string" ? values.reduce((s, v) => s.split(v).join(REDACTED), value) : value;
  }
  return out;
}

/**
 * Incorpora registros de una fuente: original con hash → empresa → sede →
 * resultado de la ejecución → contactos → procedencia. Debe llamarse dentro
 * de una transacción: o entra todo o nada, y un reintento parte de cero sin
 * duplicar ni inflar contadores.
 *
 * Reglas de identidad:
 * - Empresa: NIT normalizado cuando la fuente lo declara como NIT. Sin NIT, el
 *   código de prestador de la misma fuente (a través de sus sedes). Nunca por
 *   nombre, teléfono ni dominio.
 * - Sede: (fuente, identificador de sede).
 * - Contacto: (empresa, tipo, valor normalizado).
 *
 * Una empresa existente solo recibe datos en los campos vacíos: no se pisa lo
 * que haya aportado otra fuente.
 */
export async function ingestRecords(tx: DbExecutor, input: IngestInput): Promise<IngestStats> {
  const { sourceId, searchRunId } = input;
  const items = [...input.items].sort((a, b) => (a.raw.externalId < b.raw.externalId ? -1 : 1));

  const suppressed = await findSuppressed(
    tx,
    items.flatMap((i) => i.resolved.contacts.flatMap(suppressionCandidates)),
  );
  const isContactSuppressed = (c: ResolvedContact) =>
    suppressionCandidates(c).some((s) => suppressed.has(`${s.kind}:${s.normalizedValue}`));

  const stats: IngestStats = {
    recordsNew: 0,
    recordsUnchanged: 0,
    companiesMatched: 0,
    companiesNew: 0,
    companiesExisting: 0,
    sitesMatched: 0,
    sitesNew: 0,
    sitesExisting: 0,
    contactsNew: 0,
    contactsExisting: 0,
    contactsSuppressed: 0,
    contactsDiscarded: 0,
  };
  const newCompanies = new Set<string>();
  const seenCompanies = new Set<string>();
  const newContacts = new Set<string>();
  const seenContacts = new Set<string>();
  const suppressedValues = new Set<string>();
  const matchedSites = new Set<string>();

  for (const { raw, resolved } of items) {
    const suppressedHere = resolved.contacts.filter(isContactSuppressed);
    for (const c of suppressedHere) suppressedValues.add(`${c.kind}:${c.normalized}`);

    // 1. Registro original. El hash es del contenido publicado; lo guardado va sin lo suprimido.
    const hash = payloadHash(raw.payload);
    const [insertedRecord] = await tx
      .insert(sourceRecords)
      .values({
        sourceId,
        externalId: raw.externalId,
        payload: redact(
          raw.payload,
          suppressedHere.map((c) => c.value),
        ),
        hash,
        searchRunId,
      })
      .onConflictDoNothing({
        target: [sourceRecords.sourceId, sourceRecords.externalId, sourceRecords.hash],
      })
      .returning({ id: sourceRecords.id });
    let sourceRecordId = insertedRecord?.id;
    if (sourceRecordId) {
      stats.recordsNew++;
    } else {
      stats.recordsUnchanged++;
      const [existing] = await tx
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.sourceId, sourceId),
            eq(sourceRecords.externalId, raw.externalId),
            eq(sourceRecords.hash, hash),
          ),
        );
      sourceRecordId = existing?.id;
    }
    if (!sourceRecordId) throw new Error(`No se pudo registrar el original ${raw.externalId}`);
    const provenance = (
      entityType: "company" | "company_site" | "contact_point",
      entityId: string,
      field: string,
      /** Ámbito con que la fuente publicó el contacto; solo para contactos. */
      scope: ResolvedContact["scope"] | null = null,
    ) =>
      tx
        .insert(dataProvenance)
        .values({ entityType, entityId, field, scope, sourceRecordId, url: raw.url ?? null })
        .onConflictDoNothing({
          target: [
            dataProvenance.entityType,
            dataProvenance.entityId,
            dataProvenance.field,
            dataProvenance.sourceRecordId,
          ],
        });

    // 2. Empresa.
    const c = resolved.company;
    let companyId: string | undefined;
    if (c.nit) {
      const [created] = await tx
        .insert(companies)
        .values({
          nit: c.nit,
          legalName: c.legalName,
          companyType: c.companyType,
          cityCode: c.cityCode,
          city: c.city,
          department: c.department,
        })
        .onConflictDoNothing({ target: companies.nit, where: sql`${companies.nit} is not null` })
        .returning({ id: companies.id });
      if (created) {
        companyId = created.id;
        newCompanies.add(created.id);
      } else {
        const [existing] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.nit, c.nit));
        companyId = existing?.id;
      }
    } else {
      const [linked] = await tx
        .select({ companyId: companySites.companyId })
        .from(companySites)
        .where(
          and(eq(companySites.sourceId, sourceId), eq(companySites.providerCode, c.providerCode)),
        )
        .limit(1);
      companyId = linked?.companyId;
      if (!companyId) {
        const [created] = await tx
          .insert(companies)
          .values({
            legalName: c.legalName,
            companyType: c.companyType,
            cityCode: c.cityCode,
            city: c.city,
            department: c.department,
          })
          .returning({ id: companies.id });
        companyId = created?.id;
        if (companyId) newCompanies.add(companyId);
      }
    }
    if (!companyId)
      throw new Error(`No se pudo resolver la empresa del registro ${raw.externalId}`);
    if (!newCompanies.has(companyId) && !seenCompanies.has(companyId)) {
      // Completar solo lo que falte; lo aportado por otras fuentes no se toca.
      await tx
        .update(companies)
        .set({
          cityCode: sql`coalesce(${companies.cityCode}, ${c.cityCode})`,
          city: sql`coalesce(${companies.city}, ${c.city})`,
          department: sql`coalesce(${companies.department}, ${c.department})`,
          companyType: sql`case when ${companies.companyType} = 'otro' then ${c.companyType}::company_type else ${companies.companyType} end`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(companies.id, companyId),
            or(
              sql`${companies.cityCode} is null`,
              sql`${companies.city} is null`,
              sql`${companies.department} is null`,
              eq(companies.companyType, "otro"),
            ),
          ),
        );
    }
    seenCompanies.add(companyId);
    await provenance("company", companyId, "legal_name");

    // 3. Sede. Sus datos son de la fuente que la publica: se actualizan con el último corte.
    let siteId: string | null = null;
    if (resolved.site) {
      const s = resolved.site;
      const siteValues = {
        companyId,
        providerCode: c.providerCode,
        name: s.name,
        address: s.address,
        cityCode: s.cityCode,
        city: s.city,
        department: s.department,
        sourceCutoffAt: resolved.sourceCutoffAt,
        sourceUrl: raw.url ?? null,
      };
      const [site] = await tx
        .insert(companySites)
        .values({ sourceId, externalId: s.externalId, ...siteValues })
        .onConflictDoUpdate({
          target: [companySites.sourceId, companySites.externalId],
          set: { ...siteValues, updatedAt: sql`now()` },
        })
        .returning({ id: companySites.id, inserted: sql<boolean>`(xmax = 0)` });
      if (!site) throw new Error(`No se pudo registrar la sede ${s.externalId}`);
      siteId = site.id;
      if (site.inserted) stats.sitesNew++;
      else stats.sitesExisting++;
      await provenance("company_site", site.id, "sede");
    }

    // 3b. Resultado de ESTA ejecución: la empresa (y la sede) coincidió, aunque ya existiera.
    await tx
      .insert(searchRunResults)
      .values({
        searchRunId,
        companyId,
        siteId,
        sourceId,
        sourceRecordId,
        companyIsNew: newCompanies.has(companyId),
      })
      .onConflictDoNothing();
    if (siteId) matchedSites.add(siteId);

    // 4. Contactos, salvo los suprimidos y los que no se pudieron interpretar.
    for (const contact of resolved.contacts) {
      if (!contact.normalized) {
        stats.contactsDiscarded++;
        continue;
      }
      if (isContactSuppressed(contact)) continue;
      const [created] = await tx
        .insert(contactPoints)
        .values({
          companyId,
          kind: contact.kind,
          value: contact.value,
          valueNormalized: contact.normalized,
          isRoleAddress: contact.kind === "email" && isRoleAddress(contact.normalized),
        })
        .onConflictDoNothing({
          target: [contactPoints.companyId, contactPoints.kind, contactPoints.valueNormalized],
        })
        .returning({ id: contactPoints.id });
      let contactId = created?.id;
      if (contactId) {
        newContacts.add(contactId);
      } else {
        const [existing] = await tx
          .select({ id: contactPoints.id })
          .from(contactPoints)
          .where(
            and(
              eq(contactPoints.companyId, companyId),
              eq(contactPoints.kind, contact.kind),
              eq(contactPoints.valueNormalized, contact.normalized),
            ),
          );
        contactId = existing?.id;
      }
      if (!contactId) throw new Error(`No se pudo registrar un contacto de ${raw.externalId}`);
      seenContacts.add(contactId);
      if (contact.scope === "site" && siteId) {
        await tx
          .insert(contactPointSites)
          .values({ contactPointId: contactId, siteId })
          .onConflictDoNothing();
      }
      // El ámbito queda en la procedencia: un contacto general sigue siéndolo aunque
      // otra observación lo vincule a una sede.
      await provenance("contact_point", contactId, contact.field, contact.scope);
    }
  }

  stats.companiesMatched = seenCompanies.size;
  stats.companiesNew = newCompanies.size;
  stats.companiesExisting = seenCompanies.size - newCompanies.size;
  stats.sitesMatched = matchedSites.size;
  stats.contactsNew = newContacts.size;
  stats.contactsExisting = seenContacts.size - newContacts.size;
  stats.contactsSuppressed = suppressedValues.size;
  return stats;
}
