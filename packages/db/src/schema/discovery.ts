import { LEGAL_BASES } from "@icmspy/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies } from "./companies";

export const legalBasis = pgEnum("legal_basis", LEGAL_BASES);
export const searchRunStatus = pgEnum("search_run_status", ["queued", "running", "done", "failed"]);
export const mergeDecision = pgEnum("merge_decision", ["pending", "merged", "distinct"]);

/** Catálogo de fuentes y su base legal. */
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  legalBasis: legalBasis("legal_basis").notNull(),
  licenseUrl: text("license_url"),
  termsNotes: text("terms_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cada importación o búsqueda lanzada. */
export const searchRuns = pgTable(
  "search_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    adapter: text("adapter").notNull(),
    query: jsonb("query").notNull().default({}),
    status: searchRunStatus("status").notNull().default("queued"),
    /** Registros leídos de la fuente (en REPS, sedes). */
    foundCount: integer("found_count").notNull().default(0),
    /** Empresas nuevas creadas por la ejecución. */
    newCount: integer("new_count").notNull().default(0),
    /** Contadores detallados y metadatos de la fuente (ver SearchRunStats). */
    stats: jsonb("stats").notNull().default({}),
    /** Id del job de pg-boss que ejecuta esta búsqueda. */
    jobId: text("job_id"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("search_runs_status_idx").on(t.status),
    index("search_runs_adapter_created_idx").on(t.adapter, t.createdAt),
    // Como mucho una ejecución pendiente o en curso por fuente y consulta: lo
    // garantiza la base de datos, no un chequeo previo que pueda competir.
    uniqueIndex("search_runs_active_uq")
      .on(t.adapter, sql`md5(${t.query}::text)`)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/** Respuesta cruda de cada fuente. Inmutable: nunca se edita, solo se agrega. */
export const sourceRecords = pgTable(
  "source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").notNull(),
    /** Hash del payload: permite saltar registros que no cambiaron. */
    hash: text("hash").notNull(),
    searchRunId: uuid("search_run_id").references(() => searchRuns.id, { onDelete: "set null" }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_records_source_external_hash_uq").on(t.sourceId, t.externalId, t.hash),
    index("source_records_run_idx").on(t.searchRunId),
  ],
);

/** Quién dijo qué dato y dónde. Responde "¿de dónde salió este correo?". */
export const dataProvenance = pgTable(
  "data_provenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type", {
      enum: ["company", "company_site", "contact_point", "person"],
    }).notNull(),
    entityId: uuid("entity_id").notNull(),
    field: text("field").notNull(),
    /**
     * Ámbito con el que la fuente publicó un contacto en este registro:
     * "company" (de la empresa o prestador) o "site" (de una sede). Un mismo
     * contacto puede tener observaciones de ambos ámbitos. null en entidades
     * que no son contactos.
     */
    scope: text("scope", { enum: ["company", "site"] }),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "cascade" }),
    url: text("url"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("data_provenance_entity_idx").on(t.entityType, t.entityId),
    check(
      "data_provenance_scope_check",
      sql`${t.scope} is null or ${t.scope} in ('company', 'site')`,
    ),
    // Repetir una importación no duplica la procedencia.
    uniqueIndex("data_provenance_entity_field_record_uq").on(
      t.entityType,
      t.entityId,
      t.field,
      t.sourceRecordId,
    ),
  ],
);

/** Bitácora del crawler: evita repetir páginas y permite auditar. */
export const crawlPages = pgTable(
  "crawl_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domain: text("domain").notNull(),
    url: text("url").notNull().unique(),
    httpStatus: integer("http_status"),
    robotsAllowed: boolean("robots_allowed").notNull(),
    contentHash: text("content_hash"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("crawl_pages_domain_idx").on(t.domain)],
);

/** Posibles duplicados que necesitan revisión humana. */
export const mergeCandidates = pgTable(
  "merge_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyA: uuid("company_a")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    companyB: uuid("company_b")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    score: numeric("score", { precision: 4, scale: 3 }).notNull(),
    reason: text("reason").notNull(),
    decision: mergeDecision("decision").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("merge_candidates_pair_uq").on(t.companyA, t.companyB)],
);
