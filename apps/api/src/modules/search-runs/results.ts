import {
  companies,
  companySites,
  contactPointSites,
  contactPoints,
  type DbExecutor,
  dataProvenance,
  searchRunMatches,
  searchRunResults,
  siteServices,
  sources,
} from "@icmspy/db";
import type {
  MatchType,
  ProviderKind,
  SearchResultItem,
  SearchRunResultsResponse,
  ServiceMatchKind,
} from "@icmspy/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

export interface ResultFilters {
  /** Tipo de entidad. */
  kind?: ProviderKind;
  /** Entidades con al menos una evidencia de este tipo. */
  match?: MatchType;
}

function providerKindOf(companyType: string): ProviderKind {
  if (companyType === "ips") return "ips";
  if (companyType === "profesional_independiente") return "profesional";
  return "otro";
}

/** Primero la evidencia directa (servicio), luego la relacionada y por último el nombre. */
const MATCH_RANK: Record<MatchType, number> = { service: 0, related: 1, name: 2 };

/**
 * Entidades que encontró una ejecución, paginadas por entidad. Sale de
 * `search_run_results` y `search_run_matches`, no del catálogo: incluye las que
 * ya existían y nada que la ejecución no haya encontrado. Una entidad aparece
 * una sola vez con todas sus evidencias, de todas las fuentes.
 *
 * Contactos: los generales de la empresa (publicados con ámbito "company" en la
 * procedencia, aunque también estén vinculados a alguna sede) y los de las
 * sedes que coincidieron. Los exclusivos de otras sedes de la misma empresa no
 * se muestran aquí (están en la ficha). Consultar no crea ni modifica nada.
 */
export async function getSearchRunResults(
  db: DbExecutor,
  searchRunId: string,
  page: number,
  pageSize: number,
  filters: ResultFilters = {},
): Promise<SearchRunResultsResponse> {
  const byRun = eq(searchRunResults.searchRunId, searchRunId);

  // Todas las entidades de la ejecución con sus motivos (miles como mucho): se
  // filtran y ordenan aquí para que el total, el orden y la página coincidan.
  const entities = await db
    .select({
      companyId: companies.id,
      legalName: companies.legalName,
      nit: companies.nit,
      city: companies.city,
      department: companies.department,
      companyType: companies.companyType,
      providerClass: companies.providerClass,
      isNew: sql<boolean>`bool_or(${searchRunResults.companyIsNew})`,
    })
    .from(searchRunResults)
    .innerJoin(companies, eq(companies.id, searchRunResults.companyId))
    .where(byRun)
    .groupBy(companies.id);
  const matchRows = await db
    .selectDistinct({
      companyId: searchRunMatches.companyId,
      matchType: searchRunMatches.matchType,
      sourceKey: sources.key,
    })
    .from(searchRunMatches)
    .innerJoin(sources, eq(sources.id, searchRunMatches.sourceId))
    .where(eq(searchRunMatches.searchRunId, searchRunId));
  const typesOf = new Map<string, Set<MatchType>>();
  const sourcesOf = new Map<string, Set<string>>();
  for (const m of matchRows) {
    typesOf.set(m.companyId, (typesOf.get(m.companyId) ?? new Set()).add(m.matchType as MatchType));
    sourcesOf.set(m.companyId, (sourcesOf.get(m.companyId) ?? new Set()).add(m.sourceKey));
  }
  const rank = (id: string) =>
    Math.min(...[...(typesOf.get(id) ?? [])].map((t) => MATCH_RANK[t]), 3);

  const filtered = entities
    .map((e) => ({
      ...e,
      providerKind: providerKindOf(e.companyType),
      matchTypes: [...(typesOf.get(e.companyId) ?? [])].sort(
        (a, b) => MATCH_RANK[a] - MATCH_RANK[b],
      ),
    }))
    .filter((e) => !filters.kind || e.providerKind === filters.kind)
    .filter((e) => !filters.match || e.matchTypes.includes(filters.match))
    .sort(
      (a, b) =>
        rank(a.companyId) - rank(b.companyId) ||
        a.legalName.localeCompare(b.legalName, "es") ||
        a.companyId.localeCompare(b.companyId),
    );
  const total = filtered.length;
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
  if (rows.length === 0) return { items: [], page, pageSize, total };
  const companyIds = rows.map((r) => r.companyId);

  const sites = await db
    .select({
      companyId: searchRunResults.companyId,
      id: companySites.id,
      name: companySites.name,
      externalId: companySites.externalId,
      address: companySites.address,
      city: companySites.city,
      department: companySites.department,
    })
    .from(searchRunResults)
    .innerJoin(companySites, eq(companySites.id, searchRunResults.siteId))
    .where(and(byRun, inArray(searchRunResults.companyId, companyIds)))
    .orderBy(asc(companySites.city), asc(companySites.name), asc(companySites.externalId));

  // Evidencias por sede: nombre y servicios (con la observación vigente del servicio).
  const siteEvidence = await db
    .select({
      siteId: searchRunMatches.siteId,
      matchType: searchRunMatches.matchType,
      conceptKind: searchRunMatches.conceptKind,
      serviceCode: searchRunMatches.serviceCode,
      sourceKey: sources.key,
      sourceName: sources.name,
      serviceName: siteServices.serviceName,
      status: siteServices.status,
      modalities: siteServices.modalities,
      sourceCutoffAt: siteServices.sourceCutoffAt,
      url: siteServices.sourceUrl,
    })
    .from(searchRunMatches)
    .innerJoin(sources, eq(sources.id, searchRunMatches.sourceId))
    .leftJoin(
      siteServices,
      and(
        eq(siteServices.siteId, searchRunMatches.siteId),
        eq(siteServices.sourceId, searchRunMatches.sourceId),
        eq(siteServices.serviceCode, searchRunMatches.serviceCode),
      ),
    )
    .where(
      and(
        eq(searchRunMatches.searchRunId, searchRunId),
        inArray(searchRunMatches.companyId, companyIds),
      ),
    )
    .orderBy(asc(searchRunMatches.serviceCode));

  const points = await db
    .select({
      id: contactPoints.id,
      companyId: contactPoints.companyId,
      kind: contactPoints.kind,
      value: contactPoints.value,
      valueNormalized: contactPoints.valueNormalized,
      validationStatus: contactPoints.validationStatus,
    })
    .from(contactPoints)
    .where(inArray(contactPoints.companyId, companyIds))
    .orderBy(asc(contactPoints.kind), asc(contactPoints.valueNormalized));
  const links = points.length
    ? await db
        .select()
        .from(contactPointSites)
        .where(
          inArray(
            contactPointSites.contactPointId,
            points.map((p) => p.id),
          ),
        )
    : [];
  const linksByPoint = new Map<string, string[]>();
  for (const l of links) {
    linksByPoint.set(l.contactPointId, [...(linksByPoint.get(l.contactPointId) ?? []), l.siteId]);
  }

  // Contactos que alguna fuente publicó como de la empresa (no de una sede). Se
  // lee de la procedencia de cualquier registro y ejecución: estar vinculado
  // también a una sede no le quita el ámbito general. Una fila por contacto.
  const companyWide = new Set(
    points.length
      ? (
          await db
            .selectDistinct({ id: dataProvenance.entityId })
            .from(dataProvenance)
            .where(
              and(
                eq(dataProvenance.entityType, "contact_point"),
                eq(dataProvenance.scope, "company"),
                inArray(
                  dataProvenance.entityId,
                  points.map((p) => p.id),
                ),
              ),
            )
        ).map((r) => r.id)
      : [],
  );

  const items: SearchResultItem[] = rows.map((r) => {
    const ownMatched = sites.filter((s) => s.companyId === r.companyId);
    const ownMatchedIds = new Set(ownMatched.map((s) => s.id));
    return {
      companyId: r.companyId,
      legalName: r.legalName,
      nit: r.nit,
      city: r.city,
      department: r.department,
      companyType: r.companyType,
      providerClass: r.providerClass,
      providerKind: r.providerKind,
      matchTypes: r.matchTypes,
      isNew: Boolean(r.isNew),
      sourceKeys: [...(sourcesOf.get(r.companyId) ?? [])].sort(),
      matchedSites: ownMatched.map(({ companyId: _c, ...s }) => {
        const ev = siteEvidence.filter((e) => e.siteId === s.id);
        return {
          ...s,
          nameMatch: ev.some((e) => e.matchType === "name"),
          services: ev
            .filter((e) => e.matchType !== "name" && e.serviceCode)
            .map((e) => ({
              code: e.serviceCode as string,
              name: e.serviceName ?? (e.serviceCode as string),
              kind: (e.conceptKind ?? "related") as ServiceMatchKind,
              status: e.status,
              modalities: e.modalities ?? [],
              sourceKey: e.sourceKey,
              sourceName: e.sourceName,
              sourceCutoffAt: e.sourceCutoffAt?.toISOString() ?? null,
              url: e.url,
            })),
        };
      }),
      contacts: points
        .filter((p) => p.companyId === r.companyId)
        .map(({ companyId: _c, ...p }) => ({
          ...p,
          companyWide: companyWide.has(p.id),
          // Solo sedes que coincidieron; un vínculo con otra sede no se muestra.
          siteIds: (linksByPoint.get(p.id) ?? []).filter((id) => ownMatchedIds.has(id)),
        }))
        // General de la empresa, o publicado en una sede que coincidió. Los exclusivos
        // de otras sedes quedan fuera (están en la ficha de la empresa).
        .filter((p) => p.companyWide || p.siteIds.length > 0),
    };
  });
  return { items, page, pageSize, total };
}
