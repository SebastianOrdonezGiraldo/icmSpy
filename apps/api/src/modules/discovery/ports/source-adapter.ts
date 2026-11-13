import type { CompanyType, LegalBasis } from "@icmspy/shared";

/** Qué buscar. Cada adaptador usa los campos que entiende. */
export interface SearchQuery {
  departments?: string[];
  /** Códigos DANE de departamento (dos dígitos, p. ej. "63" para Quindío). */
  departmentCodes?: string[];
  /** Códigos DANE de municipio (cinco dígitos); vacío = todos los del departamento. */
  municipalityCodes?: string[];
  /** Clase de prestador (REPS). Solo se admiten las clases que el adaptador declara. */
  providerClass?: string;
  cities?: string[];
  /**
   * Palabras de búsqueda ya plegadas (ver `keywordTerms` en @icmspy/shared).
   * Un registro coincide si contiene todas en sus nombres.
   */
  keywords?: string[];
  /** Tope de registros, útil para pruebas. Un adaptador que no lo admite debe rechazarlo. */
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

/** Metadatos de la fuente en el momento de la consulta. */
export interface SourceSnapshot {
  /** Registros que la fuente dice tener para la consulta. */
  expectedCount: number;
  /** Última actualización de los datos en el portal. */
  updatedAt: Date | null;
  /** Página pública del conjunto de datos. */
  pageUrl: string;
}

export interface DiscoverHooks {
  onSnapshot?(snapshot: SourceSnapshot): void | Promise<void>;
  onPage?(progress: { pagesRead: number; recordsRead: number }): void | Promise<void>;
  /** Registro que la fuente devolvió pero no cumple el filtro pedido (ubicación o clase). */
  onExcluded?(record: RawRecord, reason: string): void;
  /** Registro leído que no contiene la palabra clave: no es un resultado. */
  onNotMatching?(record: RawRecord): void;
  signal?: AbortSignal;
}

export type ResolvedContactKind = "email" | "phone" | "website";

/** Un contacto ya separado y normalizado, con el campo de la fuente del que salió. */
export interface ResolvedContact {
  kind: ResolvedContactKind;
  /** Fragmento tal como aparece en la fuente. */
  value: string;
  /** null si no se pudo interpretar: no se incorpora. */
  normalized: string | null;
  /** "company" si la fuente lo publica para la empresa; "site" si es de la sede. */
  scope: "company" | "site";
  /** Campo de la fuente. */
  field: string;
}

/** Interpretación de un registro crudo: empresa, sede y contactos. */
export interface ResolvedRecord {
  company: {
    /** NIT normalizado (sin dígito de verificación), solo si la fuente dice que es un NIT. */
    nit: string | null;
    /**
     * Identificador del prestador en la fuente. Se usa para agrupar sedes de
     * una empresa sin NIT; nunca se fusiona por nombre.
     */
    providerCode: string;
    legalName: string;
    companyType: CompanyType;
    cityCode: string | null;
    city: string | null;
    department: string | null;
  };
  site: {
    externalId: string;
    name: string;
    address: string | null;
    cityCode: string | null;
    city: string | null;
    department: string | null;
  } | null;
  contacts: ResolvedContact[];
  /** Fecha de corte declarada por la fuente para este registro. */
  sourceCutoffAt: Date | null;
  sourceCutoffRaw: string | null;
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
  /**
   * true solo si el adaptador está implementado y validado. Los esqueletos
   * quedan en false y el buscador nunca los consulta ni los anuncia.
   */
  operational: boolean;
  /**
   * Qué cubre la fuente cuando el buscador la consulta, en palabras del
   * usuario. Se muestra junto a los resultados.
   */
  searchCoverage?: string;
  capabilities: readonly ("discover" | "enrich")[];
  discover?(query: SearchQuery, hooks?: DiscoverHooks): AsyncIterable<RawRecord>;
  /** Traduce un registro crudo de esta fuente a empresa, sede y contactos. */
  resolve?(record: RawRecord): ResolvedRecord;
  enrich?(company: CompanyRef): Promise<RawRecord[]>;
}
