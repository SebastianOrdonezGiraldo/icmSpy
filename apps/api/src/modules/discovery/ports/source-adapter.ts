import type { LegalBasis } from "@icmspy/shared";

/** Qué buscar. Cada adaptador usa los campos que entiende. */
export interface SearchQuery {
  departments?: string[];
  cities?: string[];
  keywords?: string[];
  /** Tope de registros, útil para pruebas. */
  limit?: number;
}

/** Lo que devolvió una fuente, sin interpretar. Se guarda tal cual en `source_records`. */
export interface RawRecord {
  /** Identificador estable dentro de la fuente (por ejemplo, código de habilitación). */
  externalId: string;
  payload: Record<string, unknown>;
  /** URL exacta donde se vio el dato, si aplica. */
  url?: string;
}

export interface CompanyRef {
  id: string;
  legalName: string;
  domain: string | null;
  city: string | null;
}

/**
 * Puerto que separa las fuentes del resto del sistema. Añadir una fuente es
 * escribir un adaptador que cumpla esta interfaz y registrarlo en
 * `adapters/index.ts`; nada más cambia.
 */
export interface SourceAdapter {
  key: string;
  name: string;
  legalBasis: LegalBasis;
  licenseUrl?: string;
  capabilities: readonly ("discover" | "enrich")[];
  discover?(query: SearchQuery): AsyncIterable<RawRecord>;
  enrich?(company: CompanyRef): Promise<RawRecord[]>;
}
