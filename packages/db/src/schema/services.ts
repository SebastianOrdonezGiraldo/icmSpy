import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies";
import { searchRuns, sourceRecords, sources } from "./discovery";
import { companySites } from "./sites";

/**
 * Servicio de salud que una fuente oficial relaciona con una sede (en REPS,
 * servicio habilitado). Una fila por sede, fuente y código de servicio con la
 * observación vigente; la historia queda en `source_records`.
 *
 * Una observación con fecha de corte anterior no sustituye a una más reciente.
 */
export const siteServices = pgTable(
  "site_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => companySites.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    /** Registro original de la última observación aceptada. */
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "set null",
    }),
    /** Código de servicio del REPS (catálogo oficial). */
    serviceCode: text("service_code").notNull(),
    /** Nombre del servicio tal como lo publica la fuente. */
    serviceName: text("service_name").notNull(),
    /** Estado publicado (p. ej. "SI" en habilitado); null si la fuente no lo publica. */
    status: text("status"),
    /** Modalidades publicadas (intramural, extramural, domiciliario, telemedicina…). */
    modalities: text("modalities").array().notNull().default(sql`'{}'::text[]`),
    /** URL reproducible del registro original en la fuente. */
    sourceUrl: text("source_url"),
    /** Fecha de corte declarada por la fuente para esta observación. */
    sourceCutoffAt: timestamp("source_cutoff_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("site_services_site_source_code_uq").on(t.siteId, t.sourceId, t.serviceCode),
    index("site_services_code_idx").on(t.serviceCode),
  ],
);

/**
 * Por qué una ejecución encontró una entidad: un servicio registrado en una
 * sede, un concepto relacionado o una coincidencia de nombre. Una entidad
 * aparece una sola vez en `search_run_results` y conserva aquí todas sus
 * evidencias, de todas las fuentes.
 */
export const searchRunMatches = pgTable(
  "search_run_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    searchRunId: uuid("search_run_id")
      .notNull()
      .references(() => searchRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => companySites.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "set null",
    }),
    /** service | related | name (ver MATCH_TYPES en @icmspy/shared). */
    matchType: text("match_type").notNull(),
    /** exact | catalog | equivalent | related para servicios; null en nombre. */
    conceptKind: text("concept_kind"),
    serviceCode: text("service_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("search_run_matches_uq")
      .on(t.searchRunId, t.companyId, t.siteId, t.sourceId, t.matchType, t.serviceCode)
      .nullsNotDistinct(),
    index("search_run_matches_run_company_idx").on(t.searchRunId, t.companyId),
    check("search_run_matches_type_check", sql`${t.matchType} in ('service', 'related', 'name')`),
  ],
);
