import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const suppressionKind = pgEnum("suppression_kind", ["email", "phone", "domain"]);

/**
 * Lista de supresión. Guarda solo el SHA-256 del valor, para recordar una
 * baja o solicitud de habeas data sin conservar el dato. Se consulta antes
 * de reimportar.
 */
export const suppressionList = pgTable(
  "suppression_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: suppressionKind("kind").notNull(),
    valueHash: text("value_hash").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppression_kind_hash_uq").on(t.kind, t.valueHash)],
);

/** Quién exportó o cambió qué. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    diff: jsonb("diff"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entity, t.entityId)],
);
