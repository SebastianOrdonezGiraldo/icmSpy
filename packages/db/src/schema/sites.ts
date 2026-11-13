import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies, contactPoints } from "./companies";
import { sources } from "./discovery";

/**
 * Sedes de una empresa tal como las publica una fuente (en REPS, cada sede
 * habilitada). Una empresa con varias sedes conserva la dirección y el
 * municipio de cada una sin pisar los de las demás.
 */
export const companySites = pgTable(
  "company_sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    /** Identificador estable de la sede en la fuente (REPS: código de habilitación de la sede). */
    externalId: text("external_id").notNull(),
    /**
     * Identificador del prestador en la fuente. En REPS es un código por
     * departamento: el mismo NIT puede tener varios.
     */
    providerCode: text("provider_code"),
    name: text("name").notNull(),
    address: text("address"),
    /** Código DANE del municipio. */
    cityCode: text("city_code"),
    city: text("city"),
    department: text("department"),
    /** Fecha de corte declarada por la fuente cuando se vio la sede por última vez. */
    sourceCutoffAt: timestamp("source_cutoff_at", { withTimezone: true }),
    /** URL reproducible del registro en la fuente. */
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("company_sites_source_external_uq").on(t.sourceId, t.externalId),
    index("company_sites_company_idx").on(t.companyId),
    index("company_sites_source_provider_idx").on(t.sourceId, t.providerCode),
  ],
);

/** Qué contactos publica la fuente para cada sede. Un contacto puede repetirse en varias sedes. */
export const contactPointSites = pgTable(
  "contact_point_sites",
  {
    contactPointId: uuid("contact_point_id")
      .notNull()
      .references(() => contactPoints.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => companySites.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.contactPointId, t.siteId] }),
    index("contact_point_sites_site_idx").on(t.siteId),
  ],
);
