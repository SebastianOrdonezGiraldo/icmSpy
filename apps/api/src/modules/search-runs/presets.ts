import {
  canonicalCriteria,
  describeCriteria,
  type ResolvedService,
  resolveServices,
  type SearchCriteria,
  type SearchCriteriaView,
  type UserRole,
} from "@icmspy/shared";
import { searchableAdapters, serviceAdaptersFor } from "../discovery/adapters";
import type { SearchQuery, SourceAdapter } from "../discovery/ports/source-adapter";

/** Todas las clases de prestador del REPS. */
export const ALL_PROVIDER_CLASSES = ["ips", "profesional", "objeto_social", "transporte"] as const;

/**
 * Consulta guardada en `search_runs.query` (versión 3, búsqueda por servicio,
 * actividad y nombre). Es canónica: dos solicitudes equivalentes producen el
 * mismo JSON, y el índice único `search_runs_active_uq` impide dos ejecuciones
 * activas iguales. Guarda los servicios resueltos: si el catálogo cambia, el
 * historial sigue diciendo qué se buscó.
 */
export interface StoredSearchQuery extends SearchQuery {
  v: 3;
  keywords: string[];
  departmentCodes: [string];
  municipalityCodes: string[];
  providerClasses: string[];
  services: ResolvedService[];
  /** Códigos de `services` (incluidos los relacionados) para las fuentes de servicios. */
  serviceCodes: string[];
  /** Fuentes que consulta la ejecución, elegidas por el sistema. */
  sources: string[];
}

/** Consulta del buscador por nombre (v2) y de la búsqueda fija anterior. */
interface OlderQuery extends SearchQuery {
  v?: 2;
  preset?: "reps-quindio";
  sources?: string[];
}

export interface SearchPlan {
  /** Fuente principal de prestadores; columna `search_runs.adapter`. */
  adapter: string;
  query: StoredSearchQuery;
}

/**
 * Convierte los criterios del usuario en la consulta de la ejecución. El
 * cliente solo aporta texto y códigos; los servicios salen del catálogo
 * oficial y las fuentes las elige el sistema entre los adaptadores operativos.
 */
export function planSearch(
  criteria: SearchCriteria,
  registry?: readonly SourceAdapter[],
): SearchPlan {
  const providers = searchableAdapters(registry).map((a) => a.key);
  const first = providers[0];
  if (!first) throw new Error("No hay fuentes operativas para el buscador");
  const c = canonicalCriteria(criteria);
  const services = resolveServices(c.keywordTerms.join(" "));
  const serviceSources = services.length
    ? serviceAdaptersFor(c.departmentCode, registry).map((a) => a.key)
    : [];
  return {
    adapter: first,
    query: {
      v: 3,
      keywords: c.keywordTerms,
      departmentCodes: [c.departmentCode],
      municipalityCodes: c.municipalityCode ? [c.municipalityCode] : [],
      providerClasses: [...ALL_PROVIDER_CLASSES],
      services,
      serviceCodes: services.map((s) => s.code),
      sources: [...providers, ...serviceSources],
    },
  };
}

/** Criterios legibles de cualquier ejecución, incluidas las anteriores. */
export function criteriaOf(query: unknown): SearchCriteriaView {
  const q = (query ?? {}) as Partial<StoredSearchQuery> & OlderQuery;
  return describeCriteria({
    keywordTerms: q.keywords ?? null,
    departmentCode: q.departmentCodes?.[0] ?? "",
    municipalityCode: q.municipalityCodes?.[0] ?? null,
    legacy: q.preset === "reps-quindio",
    services: Array.isArray(q.services) ? q.services : [],
  });
}

/** Fuentes de una ejecución. Las anteriores al buscador solo consultaban su adaptador. */
export function sourcesOf(query: unknown, adapter: string): string[] {
  const sources = (query as OlderQuery | null)?.sources;
  return Array.isArray(sources) && sources.length ? sources : [adapter];
}

/** Versión de la consulta: 3 = servicios + nombre; 2 = solo nombre; 1 = búsqueda fija. */
export function queryVersion(query: unknown): 1 | 2 | 3 {
  const v = (query as { v?: unknown } | null)?.v;
  return v === 3 ? 3 : v === 2 ? 2 : 1;
}

/** true si la ejecución guarda su lista de resultados (buscador configurable). */
export function hasResultList(query: unknown): boolean {
  return queryVersion(query) >= 2;
}

/**
 * Quién puede lanzar búsquedas. Solo leen fuentes oficiales con consultas que
 * arma el servidor y no borran nada, así que cualquier usuario con sesión
 * (admin o comercial) puede iniciarlas. Nunca es público.
 */
export const SEARCH_RUN_ROLES: readonly UserRole[] = ["admin", "comercial"];
