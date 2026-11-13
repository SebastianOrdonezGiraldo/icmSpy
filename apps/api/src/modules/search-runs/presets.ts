import {
  canonicalCriteria,
  describeCriteria,
  type SearchCriteria,
  type SearchCriteriaView,
  type UserRole,
} from "@icmspy/shared";
import { searchableAdapters } from "../discovery/adapters";
import type { SearchQuery, SourceAdapter } from "../discovery/ports/source-adapter";

/**
 * Consulta guardada en `search_runs.query` (versión 2, buscador configurable).
 * Es canónica: dos solicitudes equivalentes producen el mismo JSON, y el
 * índice único `search_runs_active_uq` impide dos ejecuciones activas iguales.
 */
export interface StoredSearchQuery extends SearchQuery {
  v: 2;
  keywords: string[];
  departmentCodes: [string];
  municipalityCodes: string[];
  providerClass: "ips";
  /** Fuentes que consulta la ejecución, elegidas por el sistema. */
  sources: string[];
}

/** Consulta de la búsqueda fija anterior ("IPS y clínicas de Quindío"). */
interface LegacyPresetQuery extends SearchQuery {
  preset: "reps-quindio";
}

export interface SearchPlan {
  /** Fuente principal; columna `search_runs.adapter`. */
  adapter: string;
  query: StoredSearchQuery;
}

/**
 * Convierte los criterios del usuario en la consulta de la ejecución. El
 * cliente solo aporta texto y códigos; las fuentes las elige el sistema entre
 * los adaptadores operativos.
 */
export function planSearch(
  criteria: SearchCriteria,
  registry?: readonly SourceAdapter[],
): SearchPlan {
  const sources = searchableAdapters(registry).map((a) => a.key);
  const first = sources[0];
  if (!first) throw new Error("No hay fuentes operativas para el buscador");
  const c = canonicalCriteria(criteria);
  return {
    adapter: first,
    query: {
      v: 2,
      keywords: c.keywordTerms,
      departmentCodes: [c.departmentCode],
      municipalityCodes: c.municipalityCode ? [c.municipalityCode] : [],
      providerClass: "ips",
      sources,
    },
  };
}

/** Criterios legibles de cualquier ejecución, incluidas las de la búsqueda fija anterior. */
export function criteriaOf(query: unknown): SearchCriteriaView {
  const q = (query ?? {}) as Partial<StoredSearchQuery & LegacyPresetQuery>;
  return describeCriteria({
    keywordTerms: q.keywords ?? null,
    departmentCode: q.departmentCodes?.[0] ?? "",
    municipalityCode: q.municipalityCodes?.[0] ?? null,
    legacy: q.preset === "reps-quindio",
  });
}

/** Fuentes de una ejecución. Las anteriores al buscador solo consultaban su adaptador. */
export function sourcesOf(query: unknown, adapter: string): string[] {
  const sources = (query as Partial<StoredSearchQuery> | null)?.sources;
  return Array.isArray(sources) && sources.length ? sources : [adapter];
}

/** true si la ejecución guarda su lista de resultados (buscador configurable). */
export function hasResultList(query: unknown): boolean {
  return (query as Partial<StoredSearchQuery> | null)?.v === 2;
}

/**
 * Quién puede lanzar búsquedas. Solo leen fuentes oficiales con consultas que
 * arma el servidor y no borran nada, así que cualquier usuario con sesión
 * (admin o comercial) puede iniciarlas. Nunca es público.
 */
export const SEARCH_RUN_ROLES: readonly UserRole[] = ["admin", "comercial"];
