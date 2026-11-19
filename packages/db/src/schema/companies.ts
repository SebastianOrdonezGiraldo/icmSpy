import { COMPANY_TYPES, CONTACT_KINDS, VALIDATION_STATUSES } from "@icmspy/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const companyType = pgEnum("company_type", COMPANY_TYPES);
export const contactKind = pgEnum("contact_kind", CONTACT_KINDS);
export const validationStatus = pgEnum("validation_status", VALIDATION_STATUSES);

/** Empresa canónica: una fila por entidad real, ya fusionada entre fuentes. */
export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Solo cuando la fuente declara que la identificación es un NIT. */
    nit: text("nit"),
    /**
     * Identificación tal como la publica la fuente (REPS: NI, CC, CE, PT…) y su
     * número. Una cédula se guarda aquí, nunca en `nit`.
     */
    identificationType: text("identification_type"),
    identificationNumber: text("identification_number"),
    /** Clase de prestador publicada por la fuente (REPS: IPS, Profesional Independiente…). */
    providerClass: text("provider_class"),
    /** Persona natural o jurídica, solo si la fuente lo declara. */
    personKind: text("person_kind", { enum: ["natural", "juridica"] }),
    legalName: text("legal_name").notNull(),
    tradeName: text("trade_name"),
    domain: text("domain"),
    /** Código DANE del municipio. */
    cityCode: text("city_code"),
    city: text("city"),
    department: text("department"),
    ciiuCodes: text("ciiu_codes").array().notNull().default(sql`'{}'::text[]`),
    companyType: companyType("company_type").notNull().default("otro"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("companies_nit_uq").on(t.nit).where(sql`${t.nit} is not null`),
    // Identidad de quien no tiene NIT (p. ej. un profesional con cédula): un registro por persona.
    uniqueIndex("companies_identification_uq")
      .on(t.identificationType, t.identificationNumber)
      .where(sql`${t.identificationType} is not null and ${t.identificationNumber} is not null`),
    uniqueIndex("companies_domain_uq").on(t.domain).where(sql`${t.domain} is not null`),
    index("companies_legal_name_trgm").using("gin", sql`${t.legalName} gin_trgm_ops`),
    index("companies_trade_name_trgm").using("gin", sql`${t.tradeName} gin_trgm_ops`),
    index("companies_department_city_idx").on(t.department, t.city),
    index("companies_type_idx").on(t.companyType),
  ],
);

/** Personas de contacto. Es dato personal: tratar según la Ley 1581. */
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    jobTitle: text("job_title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("people_company_idx").on(t.companyId)],
);

/** Cada correo, teléfono, sitio web o red social de una empresa. */
export const contactPoints = pgTable(
  "contact_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    kind: contactKind("kind").notNull(),
    value: text("value").notNull(),
    valueNormalized: text("value_normalized").notNull(),
    /** true para direcciones de rol (info@, ventas@), no personales. */
    isRoleAddress: boolean("is_role_address").notNull().default(false),
    validationStatus: validationStatus("validation_status").notNull().default("unknown"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contact_points_company_kind_value_uq").on(t.companyId, t.kind, t.valueNormalized),
    index("contact_points_value_idx").on(t.kind, t.valueNormalized),
  ],
);
