import { boolean, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies";
import { searchRuns, sourceRecords, sources } from "./discovery";
import { companySites } from "./sites";

/**
 * Qué encontró cada ejecución: empresa, sede coincidente y fuente. Se escribe
 * en la misma transacción que incorpora los datos y cierra la ejecución.
 *
 * No se reconstruye desde `source_records.search_run_id`: un original idéntico
 * se reutiliza y ese campo apunta a la primera ejecución que lo guardó, así que
 * una segunda búsqueda perdería sus coincidencias.
 */
export const searchRunResults = pgTable(
  "search_run_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    searchRunId: uuid("search_run_id")
      .notNull()
      .references(() => searchRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Sede que coincidió; null si la fuente no publica sedes. */
    siteId: uuid("site_id").references(() => companySites.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    /** Registro original que produjo la coincidencia. */
    sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, {
      onDelete: "set null",
    }),
    /** La empresa se creó en esta ejecución. */
    companyIsNew: boolean("company_is_new").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("search_run_results_run_company_site_uq")
      .on(t.searchRunId, t.companyId, t.siteId)
      .nullsNotDistinct(),
    index("search_run_results_run_company_idx").on(t.searchRunId, t.companyId),
  ],
);
