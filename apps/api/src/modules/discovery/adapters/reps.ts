import { type CompanyType, matchesKeyword } from "@icmspy/shared";
import { z } from "zod";
import { normalizeNit, parseEmails, parsePhonesCO } from "../../enrichment/normalize";
import { landlineAreaForMunicipality } from "../../enrichment/phone-areas";
import {
  SourceConsistencyError,
  SourceHttpError,
  SourceQueryError,
  SourceSchemaError,
  SourceUnavailableError,
} from "../errors";
import type {
  DiscoverHooks,
  RawRecord,
  ResolvedContact,
  ResolvedRecord,
  SearchQuery,
  SourceAdapter,
} from "../ports/source-adapter";

/**
 * Registro Especial de Prestadores y Sedes de Servicios de Salud (REPS),
 * publicado por el Ministerio de Salud en datos.gov.co (API Socrata).
 * Validación de la fuente: docs/fuentes/reps.md.
 */
export const REPS_DATASET_ID = "c36g-9fc2";
const PORTAL = "https://www.datos.gov.co";
export const REPS_RESOURCE_URL = `${PORTAL}/resource/${REPS_DATASET_ID}.json`;
const METADATA_URL = `${PORTAL}/api/views/${REPS_DATASET_ID}.json`;
export const REPS_PAGE_URL =
  "https://www.datos.gov.co/Salud-y-Protecci-n-Social/Registro-Especial-de-Prestadores-y-Sedes-de-Servic/c36g-9fc2";
const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/legalcode";

/** Clases de prestador admitidas, con el valor exacto de `claseprestador` en la fuente. */
export const REPS_PROVIDER_CLASSES = {
  ips: "Instituciones Prestadoras de Servicios de Salud - IPS",
  profesional: "Profesional Independiente",
  objeto_social: "Objeto Social Diferente a la Prestación de Servicios de Salud",
  transporte: "Transporte Especial de Pacientes",
} as const;
export type ProviderClassKey = keyof typeof REPS_PROVIDER_CLASSES;

/**
 * Tipo de actividad según la clase publicada. Un profesional independiente no
 * es una IPS; "objeto social diferente" y transporte quedan como "otro".
 */
const COMPANY_TYPE_BY_CLASS: Record<string, CompanyType> = {
  [REPS_PROVIDER_CLASSES.ips]: "ips",
  [REPS_PROVIDER_CLASSES.profesional]: "profesional_independiente",
  [REPS_PROVIDER_CLASSES.objeto_social]: "otro",
  [REPS_PROVIDER_CLASSES.transporte]: "otro",
};

/** Columnas que se piden y el tipo que el portal declara para cada una. */
const COLUMNS = {
  codigoprestador: "text",
  nombreprestador: "text",
  codigohabilitacionsede: "text",
  nombresede: "text",
  tipoid: "text",
  numeroidentificacion: "number",
  naturalezajuridica: "text",
  ese: "text",
  municipio_prestador: "text",
  departamentoprestadordesc: "text",
  municipioprestadordesc: "text",
  direccionprestador: "text",
  email_prestador: "text",
  telefonoprestador: "text",
  municipiosede: "text",
  departamentodededesc: "text",
  municipiosededesc: "text",
  direcci_nsede: "text",
  email_sede: "text",
  t_lefonosede: "text",
  claseprestador: "text",
  fecha_corte_reps: "text",
} as const;

const optionalText = z.string().optional().nullable();
const daneCity = z.string().regex(/^\d{5}$/, "debe ser un código DANE de 5 dígitos");

/** Estructura de una fila. Los campos opcionales son los que el portal reporta con vacíos. */
export const repsRowSchema = z.object({
  codigoprestador: z.string().regex(/^\d+$/, "debe ser numérico"),
  nombreprestador: z.string().min(1),
  codigohabilitacionsede: z.string().regex(/^\d+$/, "debe ser numérico"),
  nombresede: z.string().min(1),
  tipoid: z.string().min(1),
  numeroidentificacion: z.union([z.string(), z.number()]).transform(String),
  naturalezajuridica: optionalText,
  ese: optionalText,
  municipio_prestador: daneCity,
  departamentoprestadordesc: z.string().min(1),
  municipioprestadordesc: z.string().min(1),
  direccionprestador: optionalText,
  email_prestador: optionalText,
  telefonoprestador: optionalText,
  municipiosede: daneCity,
  departamentodededesc: z.string().min(1),
  municipiosededesc: z.string().min(1),
  direcci_nsede: optionalText,
  email_sede: optionalText,
  t_lefonosede: optionalText,
  claseprestador: z.string().min(1),
  fecha_corte_reps: z.string().min(1),
});
export type RepsRow = z.infer<typeof repsRowSchema>;

const metadataSchema = z.object({
  rowsUpdatedAt: z.number().optional(),
  columns: z.array(z.object({ fieldName: z.string(), dataTypeName: z.string() })),
});
const countSchema = z.tuple([z.object({ total: z.string().regex(/^\d+$/) })]);

const MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/**
 * "Fecha corte REPS: Mar 12 2026  3:11PM" → Date. La hora se interpreta en
 * hora de Colombia (UTC-5). Devuelve null si el formato cambia.
 */
export function parseRepsCutoff(raw: string): Date | null {
  const m = /(\w{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(raw);
  const month = m
    ? MONTHS[`${m[1]?.[0]?.toUpperCase()}${m[1]?.slice(1).toLowerCase()}`]
    : undefined;
  if (!m || !month) return null;
  let hour = Number(m[4]) % 12;
  if (m[6]?.toUpperCase() === "PM") hour += 12;
  const pad = (n: number | string) => String(n).padStart(2, "0");
  const date = new Date(`${m[3]}-${pad(month)}-${pad(m[2] ?? "")}T${pad(hour)}:${m[5]}:00-05:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function soqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Valida la consulta y arma el filtro SoQL. Nada de lo que llega del cliente va crudo a la URL. */
export function buildRepsWhere(query: SearchQuery) {
  if (query.limit !== undefined) {
    throw new SourceQueryError("REPS no admite un tope de registros: siempre se lee completo");
  }
  const codes = query.departmentCodes ?? [];
  if (codes.length === 0 || codes.some((c) => !/^\d{2}$/.test(c))) {
    throw new SourceQueryError("REPS requiere códigos DANE de departamento de dos dígitos");
  }
  const municipalities = query.municipalityCodes ?? [];
  if (municipalities.some((m) => !/^\d{5}$/.test(m) || !codes.some((c) => m.startsWith(c)))) {
    throw new SourceQueryError("Municipio no válido para el departamento pedido");
  }
  const keywords = query.keywords ?? [];
  if (keywords.some((k) => typeof k !== "string" || k.trim() === "" || k.length > 80)) {
    throw new SourceQueryError("Palabra clave no válida");
  }
  const classKeys = query.providerClasses ?? (query.providerClass ? [query.providerClass] : []);
  const providerClasses = classKeys.map((k) => REPS_PROVIDER_CLASSES[k as ProviderClassKey]);
  if (providerClasses.length === 0 || providerClasses.some((c) => !c)) {
    throw new SourceQueryError("Clase de prestador no admitida para REPS");
  }
  const classFilter =
    providerClasses.length === 1
      ? `claseprestador = ${soqlString(providerClasses[0] as string)}`
      : `claseprestador in (${providerClasses.map((c) => soqlString(c as string)).join(", ")})`;
  // Filtro geográfico por la ubicación de la SEDE, no la del prestador: una
  // empresa domiciliada en otro lugar aparece si tiene una sede aquí.
  const geo = municipalities.length
    ? municipalities.map((m) => `municipiosede = ${soqlString(m)}`).join(" OR ")
    : codes.map((c) => `starts_with(municipiosede, ${soqlString(c)})`).join(" OR ");
  return {
    // La palabra clave no va a SoQL: no ignora tildes. Se aplica al leer cada fila.
    where: `(${geo}) AND ${classFilter}`,
    codes,
    municipalities,
    keywords,
    providerClasses: providerClasses as string[],
  };
}

export function repsRecordUrl(siteCode: string) {
  return `${REPS_RESOURCE_URL}?codigohabilitacionsede=${encodeURIComponent(siteCode)}`;
}

function clean(value: string | null | undefined): string | null {
  const v = value?.replace(/\s+/g, " ").trim();
  return v ? v : null;
}

function contactsFrom(
  text: string | null | undefined,
  kind: "email" | "phone",
  scope: ResolvedContact["scope"],
  field: string,
  landlineArea: string | undefined,
): ResolvedContact[] {
  if (!text?.trim()) return [];
  const parsed = kind === "email" ? parseEmails(text) : parsePhonesCO(text, { landlineArea });
  return parsed.map((p) => ({ kind, value: p.raw, normalized: p.normalized, scope, field }));
}

/** Traduce una fila de REPS. REPS no publica sitio web: no se deriva de ningún otro campo. */
export function resolveRepsRow(row: RepsRow): ResolvedRecord {
  // Teléfonos de la sede con el indicativo de su municipio; los del prestador, con el del prestador.
  const siteArea = landlineAreaForMunicipality(row.municipiosede);
  const providerArea = landlineAreaForMunicipality(row.municipio_prestador);
  const cutoffRaw = clean(row.fecha_corte_reps);
  const idType = row.tipoid.trim().toUpperCase();
  return {
    company: {
      // Solo es NIT si la fuente lo dice; una cédula nunca se trata como NIT.
      nit: idType === "NI" ? normalizeNit(row.numeroidentificacion) : null,
      // La identificación se conserva con su tipo (CC, CE, PT…): identidad estable de una persona.
      identificationType: idType || null,
      identificationNumber: row.numeroidentificacion.replace(/\D/g, "") || null,
      providerClass: clean(row.claseprestador),
      // REPS no declara si es persona natural o jurídica: no se deduce.
      personKind: null,
      providerCode: row.codigoprestador,
      legalName: clean(row.nombreprestador) ?? row.nombreprestador,
      companyType: COMPANY_TYPE_BY_CLASS[row.claseprestador] ?? "otro",
      cityCode: row.municipio_prestador,
      city: clean(row.municipioprestadordesc),
      department: clean(row.departamentoprestadordesc),
    },
    site: {
      externalId: row.codigohabilitacionsede,
      name: clean(row.nombresede) ?? row.nombresede,
      address: clean(row.direcci_nsede),
      cityCode: row.municipiosede,
      city: clean(row.municipiosededesc),
      department: clean(row.departamentodededesc),
    },
    contacts: [
      ...contactsFrom(row.email_sede, "email", "site", "email_sede", siteArea),
      ...contactsFrom(row.t_lefonosede, "phone", "site", "t_lefonosede", siteArea),
      ...contactsFrom(row.email_prestador, "email", "company", "email_prestador", providerArea),
      ...contactsFrom(row.telefonoprestador, "phone", "company", "telefonoprestador", providerArea),
    ],
    sourceCutoffAt: cutoffRaw ? parseRepsCutoff(cutoffRaw) : null,
    sourceCutoffRaw: cutoffRaw,
  };
}

/** Valida una fila con mensajes que nombran el campo, nunca el valor. */
export function parseRepsRow(payload: unknown, position: string): RepsRow {
  const parsed = repsRowSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "(fila)";
  throw new SourceSchemaError(`registro ${position}, campo "${field}": ${issue?.message ?? ""}`);
}

export interface RepsAdapterOptions {
  fetch?: typeof fetch;
  pageSize?: number;
  timeoutMs?: number;
}

export function createRepsAdapter(options: RepsAdapterOptions = {}): SourceAdapter {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const pageSize = options.pageSize ?? 1000;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new SourceUnavailableError(
        timedOut
          ? `La fuente no respondió en ${Math.round(timeoutMs / 1000)} s`
          : "No se pudo conectar con datos.gov.co",
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
      const detail = typeof body?.message === "string" ? body.message.slice(0, 200) : undefined;
      throw new SourceHttpError(res.status, detail);
    }
    try {
      return await res.json();
    } catch {
      throw new SourceSchemaError("la respuesta no es JSON válido");
    }
  }

  async function checkColumns(signal?: AbortSignal) {
    const parsed = metadataSchema.safeParse(await getJson(METADATA_URL, signal));
    if (!parsed.success)
      throw new SourceSchemaError("los metadatos del conjunto no tienen columnas");
    const declared = new Map(parsed.data.columns.map((c) => [c.fieldName, c.dataTypeName]));
    for (const [name, type] of Object.entries(COLUMNS)) {
      const actual = declared.get(name);
      if (!actual) throw new SourceSchemaError(`falta la columna "${name}"`);
      if (actual !== type) {
        throw new SourceSchemaError(
          `la columna "${name}" es de tipo ${actual}, se esperaba ${type}`,
        );
      }
    }
    const updated = parsed.data.rowsUpdatedAt;
    return updated ? new Date(updated * 1000) : null;
  }

  async function* discover(query: SearchQuery, hooks: DiscoverHooks = {}) {
    const { where, codes, municipalities, keywords, providerClasses } = buildRepsWhere(query);
    const updatedAt = await checkColumns(hooks.signal);

    const countUrl = `${REPS_RESOURCE_URL}?${new URLSearchParams({
      $select: "count(*) AS total",
      $where: where,
    })}`;
    const count = countSchema.safeParse(await getJson(countUrl, hooks.signal));
    if (!count.success) throw new SourceSchemaError("el conteo no tiene el formato esperado");
    const expectedCount = Number(count.data[0].total);
    await hooks.onSnapshot?.({ expectedCount, updatedAt, pageUrl: REPS_PAGE_URL });

    const seen = new Set<string>();
    let recordsRead = 0;
    let pagesRead = 0;
    // Margen para detectar una paginación que no termina.
    const maxPages = Math.ceil(expectedCount / pageSize) + 2;

    for (let offset = 0; ; offset += pageSize) {
      if (pagesRead >= maxPages) {
        throw new SourceConsistencyError(
          `La paginación no terminó tras ${pagesRead} páginas (se esperaban ${expectedCount} registros)`,
        );
      }
      const url = `${REPS_RESOURCE_URL}?${new URLSearchParams({
        $select: Object.keys(COLUMNS).join(","),
        $where: where,
        // Código de sede: único en todo el conjunto, da un orden estable entre páginas.
        $order: "codigohabilitacionsede",
        $limit: String(pageSize),
        $offset: String(offset),
      })}`;
      const page = await getJson(url, hooks.signal);
      if (!Array.isArray(page))
        throw new SourceSchemaError("la página no es una lista de registros");
      pagesRead++;

      for (const [i, payload] of page.entries()) {
        const row = parseRepsRow(payload, `#${offset + i + 1}`);
        recordsRead++;
        if (seen.has(row.codigohabilitacionsede)) {
          throw new SourceConsistencyError(
            "La fuente devolvió una sede repetida entre páginas; los datos cambiaron durante la lectura",
          );
        }
        seen.add(row.codigohabilitacionsede);
        const record: RawRecord = {
          externalId: row.codigohabilitacionsede,
          payload: payload as Record<string, unknown>,
          url: repsRecordUrl(row.codigohabilitacionsede),
        };
        if (!codes.some((c) => row.municipiosede.startsWith(c))) {
          hooks.onExcluded?.(record, "departamento");
          continue;
        }
        if (municipalities.length && !municipalities.includes(row.municipiosede)) {
          hooks.onExcluded?.(record, "municipio");
          continue;
        }
        if (!providerClasses.includes(row.claseprestador)) {
          hooks.onExcluded?.(record, "clase de prestador");
          continue;
        }
        // Palabra clave: todas las palabras en el nombre del prestador o de la sede.
        if (keywords.length && !matchesKeyword(keywords, [row.nombreprestador, row.nombresede])) {
          hooks.onNotMatching?.(record);
          continue;
        }
        yield record;
      }
      await hooks.onPage?.({ pagesRead, recordsRead });
      if (page.length < pageSize) break;
    }

    if (recordsRead !== expectedCount) {
      throw new SourceConsistencyError(
        `La fuente anunció ${expectedCount} registros y se leyeron ${recordsRead}; los datos cambiaron durante la lectura`,
      );
    }
  }

  /** Municipio de cada sede que existe hoy en REPS, consultando por código (lotes de 100). */
  async function lookupSiteLocations(siteCodes: string[], signal?: AbortSignal) {
    const found = new Map<string, string>();
    const unique = [...new Set(siteCodes)].filter((c) => /^\d+$/.test(c));
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const url = `${REPS_RESOURCE_URL}?${new URLSearchParams({
        $select: "codigohabilitacionsede,municipiosede",
        $where: `codigohabilitacionsede in (${chunk.map(soqlString).join(", ")})`,
        $limit: String(chunk.length + 1),
      })}`;
      const rows = await getJson(url, signal);
      if (!Array.isArray(rows)) throw new SourceSchemaError("la consulta de sedes no es una lista");
      for (const r of rows as { codigohabilitacionsede?: unknown; municipiosede?: unknown }[]) {
        if (typeof r.codigohabilitacionsede === "string" && typeof r.municipiosede === "string") {
          found.set(r.codigohabilitacionsede, r.municipiosede);
        }
      }
    }
    return found;
  }

  return {
    key: "reps",
    name: "REPS (datos.gov.co)",
    legalBasis: "open_data",
    licenseUrl: LICENSE_URL,
    operational: true,
    role: "providers",
    searchCoverage:
      "Prestadores registrados en REPS (IPS, profesionales independientes, entidades con objeto social diferente y transporte de pacientes) por la ubicación de sus sedes. Publica nombres y contactos, no los servicios de cada sede.",
    capabilities: ["discover"],
    discover,
    lookupSiteLocations,
    resolve(record) {
      return resolveRepsRow(parseRepsRow(record.payload, record.externalId));
    },
  };
}

export const repsAdapter = createRepsAdapter();
