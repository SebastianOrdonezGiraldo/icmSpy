import { z } from "zod";
import { getDepartment, getMunicipality, municipalityBelongsTo } from "./geo";

// --- Palabra clave -----------------------------------------------------------
//
// Semántica (la misma en API, worker, pruebas e interfaz):
// - Se ignoran mayúsculas, minúsculas y tildes ("Odontológica" = "ODONTOLOGICA").
// - Las palabras se separan por espacios. Coincide un registro que contiene TODAS
//   las palabras, en cualquier orden, como texto literal dentro del nombre del
//   prestador o del nombre de la sede (pueden repartirse entre ambos nombres).
// - Coincidencia por contenido: "odonto" encuentra "ODONTOLOGIA" y "ODONTOLÓGICA".
// - Nada se interpreta como SQL, expresión regular ni comodín: "%", "_", "." o "*"
//   son caracteres literales.

export const KEYWORD_MAX_LENGTH = 80;
export const KEYWORD_MAX_TERMS = 6;
export const KEYWORD_MIN_TERM_LENGTH = 2;

/** Minúsculas, sin tildes ni diacríticos y con espacios colapsados. */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras de búsqueda, plegadas, sin repetir y ordenadas: forma canónica. */
export function keywordTerms(keyword: string): string[] {
  return [...new Set(foldText(keyword).split(" ").filter(Boolean))].sort();
}

/** true si todas las palabras aparecen en alguno de los textos (plegados). */
export function matchesKeyword(
  terms: readonly string[],
  texts: readonly (string | null | undefined)[],
): boolean {
  const haystack = foldText(texts.filter(Boolean).join(" \u0000 "));
  return terms.length > 0 && terms.every((t) => haystack.includes(t));
}

// --- Criterios de búsqueda ---------------------------------------------------

/**
 * Lo que envía la interfaz. Solo códigos y texto: el servidor elige las
 * fuentes y arma las consultas; el cliente nunca envía URLs ni filtros externos.
 */
export const searchCriteriaSchema = z
  .object({
    keyword: z
      .string()
      .trim()
      .min(KEYWORD_MIN_TERM_LENGTH, "Escribe una palabra clave")
      .max(KEYWORD_MAX_LENGTH, `Máximo ${KEYWORD_MAX_LENGTH} caracteres`)
      // Controles o U+FFFD (texto mal codificado: "cl�nica" no es "clínica").
      .refine((v) => !/[\p{Cc}�]/u.test(v), "La palabra clave tiene caracteres no válidos"),
    departmentCode: z.string().regex(/^\d{2}$/, "Departamento no válido"),
    municipalityCode: z
      .string()
      .regex(/^\d{5}$/, "Municipio no válido")
      .nullish()
      .transform((v) => v ?? null),
  })
  .superRefine((c, ctx) => {
    const terms = keywordTerms(c.keyword);
    if (terms.length === 0) {
      ctx.addIssue({ code: "custom", path: ["keyword"], message: "Escribe una palabra clave" });
    } else if (terms.length > KEYWORD_MAX_TERMS) {
      ctx.addIssue({
        code: "custom",
        path: ["keyword"],
        message: `Máximo ${KEYWORD_MAX_TERMS} palabras`,
      });
    } else if (terms.some((t) => t.length < KEYWORD_MIN_TERM_LENGTH)) {
      ctx.addIssue({
        code: "custom",
        path: ["keyword"],
        message: `Cada palabra debe tener al menos ${KEYWORD_MIN_TERM_LENGTH} caracteres`,
      });
    }
    if (!getDepartment(c.departmentCode)) {
      ctx.addIssue({ code: "custom", path: ["departmentCode"], message: "Departamento no válido" });
    } else if (c.municipalityCode && !municipalityBelongsTo(c.municipalityCode, c.departmentCode)) {
      ctx.addIssue({
        code: "custom",
        path: ["municipalityCode"],
        message: "El municipio no pertenece al departamento",
      });
    }
  });
export type SearchCriteriaInput = z.input<typeof searchCriteriaSchema>;
export type SearchCriteria = z.output<typeof searchCriteriaSchema>;

/**
 * Criterios en forma canónica: dos solicitudes equivalentes ("Odontológica "
 * y "odontologica") producen exactamente el mismo valor.
 */
export interface CanonicalCriteria {
  keywordTerms: string[];
  departmentCode: string;
  municipalityCode: string | null;
}

export function canonicalCriteria(c: SearchCriteria): CanonicalCriteria {
  return {
    keywordTerms: keywordTerms(c.keyword),
    departmentCode: c.departmentCode,
    municipalityCode: c.municipalityCode,
  };
}

/** Criterios tal como se muestran. */
export interface SearchCriteriaView {
  /** Palabras buscadas (forma canónica); null en la búsqueda fija anterior. */
  keyword: string | null;
  departmentCode: string;
  departmentName: string;
  municipalityCode: string | null;
  municipalityName: string | null;
  /** Texto legible de la búsqueda. */
  label: string;
  /** Ejecución de la búsqueda fija "IPS y clínicas de Quindío", anterior al buscador. */
  legacy: boolean;
}

export function describeCriteria(c: {
  keywordTerms: readonly string[] | null;
  departmentCode: string;
  municipalityCode: string | null;
  legacy?: boolean;
}): SearchCriteriaView {
  const department = getDepartment(c.departmentCode)?.name ?? c.departmentCode;
  const municipality = c.municipalityCode
    ? (getMunicipality(c.municipalityCode)?.name ?? c.municipalityCode)
    : null;
  const keyword = c.keywordTerms?.length ? c.keywordTerms.join(" ") : null;
  const place = municipality ? `${municipality}, ${department}` : department;
  return {
    keyword,
    departmentCode: c.departmentCode,
    departmentName: department,
    municipalityCode: c.municipalityCode,
    municipalityName: municipality,
    label: c.legacy
      ? `IPS y clínicas de ${place} (búsqueda fija anterior)`
      : `“${keyword}” en ${place}`,
    legacy: Boolean(c.legacy),
  };
}

// --- Ejecuciones -------------------------------------------------------------

export const searchRunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const searchRunResultsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const SEARCH_RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type SearchRunStatus = (typeof SEARCH_RUN_STATUSES)[number];

/** Resultado de una fuente dentro de una ejecución. */
export interface SearchRunSourceStats {
  key: string;
  name: string;
  /** Registros que la fuente dijo tener para el filtro geográfico y de clase. */
  recordsExpected?: number;
  /** Registros leídos de la fuente. */
  recordsRead?: number;
  /** Registros que cumplen la palabra clave. */
  recordsMatched?: number;
  /** Fecha de corte declarada por la fuente (ISO). */
  sourceCutoffAt?: string | null;
  sourceCutoffRaw?: string | null;
  /** Última actualización del conjunto en el portal (ISO). */
  sourceUpdatedAt?: string | null;
  sourceUrl?: string;
}

/**
 * Contadores de una ejecución. Cada uno cuenta una cosa distinta: los
 * registros leídos son sedes de REPS, no empresas.
 */
export interface SearchRunStats {
  /** Intento actual (1 = primero). */
  attempt?: number;
  maxAttempts?: number;
  /** Fase en curso mientras status = running. */
  phase?: "fetching" | "saving";
  /** Registros (sedes) que la fuente dijo tener para el filtro geográfico y de clase. */
  recordsExpected?: number;
  /** Registros (sedes) leídos de la fuente. */
  recordsRead?: number;
  pagesRead?: number;
  /** Registros que la fuente devolvió fuera del departamento, municipio o clase pedidos. */
  recordsExcluded?: number;
  /** Registros leídos que no contienen la palabra clave. */
  recordsNotMatching?: number;
  /** Registros que cumplen todos los criterios: son los que se incorporan. */
  recordsMatched?: number;
  /** Registros originales guardados por primera vez o con contenido cambiado. */
  recordsNew?: number;
  /** Registros idénticos a uno ya guardado. */
  recordsUnchanged?: number;
  /** Empresas que coinciden con la búsqueda (nuevas + existentes). */
  companiesMatched?: number;
  /** Empresas creadas en esta ejecución. */
  companiesNew?: number;
  /** Empresas que ya existían y coinciden con la búsqueda. */
  companiesExisting?: number;
  /** Sedes que coinciden con la búsqueda. */
  sitesMatched?: number;
  sitesNew?: number;
  sitesExisting?: number;
  contactsNew?: number;
  contactsExisting?: number;
  /** Contactos omitidos por estar en la lista de supresión. */
  contactsSuppressed?: number;
  /** Valores de contacto que no se pudieron interpretar (se conservan solo en el registro original). */
  contactsDiscarded?: number;
  /** Fecha de corte declarada por la fuente (ISO), si se pudo interpretar. */
  sourceCutoffAt?: string | null;
  /** Fecha de corte tal como la publica la fuente. */
  sourceCutoffRaw?: string | null;
  /** Última actualización del conjunto de datos en el portal (ISO). */
  sourceUpdatedAt?: string | null;
  /** Página de la fuente para consulta humana. */
  sourceUrl?: string;
  /** Detalle por fuente consultada. */
  sources?: SearchRunSourceStats[];
}

export interface SearchRunDto {
  id: string;
  criteria: SearchCriteriaView;
  /** Fuentes consultadas (o que se consultarán) por esta ejecución. */
  sources: { key: string; name: string /** Qué cubre la fuente. */; coverage: string | null }[];
  status: SearchRunStatus;
  /** Registros (sedes) leídos. */
  foundCount: number;
  /** Empresas nuevas. */
  newCount: number;
  stats: SearchRunStats;
  error: string | null;
  /** false en ejecuciones anteriores al buscador: no guardaron su lista de resultados. */
  hasResults: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface CreateSearchRunResponse {
  run: SearchRunDto;
  /** false si ya había una ejecución pendiente o en curso equivalente y se devolvió esa. */
  created: boolean;
}

/** Una empresa encontrada por una ejecución, con las sedes que coincidieron. */
export interface SearchResultItem {
  companyId: string;
  legalName: string;
  nit: string | null;
  city: string | null;
  department: string | null;
  /** La empresa se creó en esta ejecución. */
  isNew: boolean;
  /** Fuentes que aportaron la coincidencia. */
  sourceKeys: string[];
  matchedSites: {
    id: string;
    name: string;
    externalId: string;
    address: string | null;
    city: string | null;
    department: string | null;
  }[];
  /** Contactos de la empresa (de las sedes que coincidieron o de la empresa). */
  contacts: {
    id: string;
    kind: string;
    value: string;
    valueNormalized: string;
    validationStatus: string;
    /**
     * true si alguna fuente lo publica como contacto general de la empresa. Puede
     * serlo y a la vez estar en `siteIds`.
     */
    companyWide: boolean;
    /** Sedes coincidentes de esta búsqueda donde se publica (nunca otras sedes). */
    siteIds: string[];
  }[];
}

export interface SearchRunResultsResponse {
  items: SearchResultItem[];
  page: number;
  pageSize: number;
  total: number;
}
