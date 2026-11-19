import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Recolección de seguidores de una cuenta de Instagram (núcleo en
 * apps/api/src/modules/instagram). Las reglas de negocio viven en `rules.ts`;
 * estas restricciones son la red de seguridad de la base de datos.
 *
 * Cada operación del contrato `RunStore` es una transacción que empieza con
 * `SELECT … FROM instagram_runs WHERE id = $1 FOR UPDATE`: la fila de la
 * ejecución serializa todas las escrituras de esa ejecución.
 */

/** drizzle-orm 0.45 no incluye `bytea`; se usa para la clave SHA-256 de cada operación. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Clave de operación: SHA-256 de una codificación canónica e inequívoca de la operación.
 *   resolución              → 'R'
 *   página, cursor null     → 'N'
 *   página, cursor de texto → 'S' || cursor   (incluidos "null" y la cadena vacía)
 *   perfil de un seguidor   → 'P' || ID del seguidor
 * Ocupa siempre 32 bytes, así que los índices únicos admiten cursores de cualquier longitud
 * sin truncarlos. El cursor original se guarda íntegro en `request_cursor`; un CHECK obliga a
 * que la clave sea exactamente el hash de ese cursor.
 */
export const INSTAGRAM_OPERATION_KEY_SQL = `sha256(convert_to(case when kind = 'resolve' then 'R' when kind = 'profile' then 'P' || profile_pk when request_cursor is null then 'N' else 'S' || request_cursor end, 'UTF8'))`;

export const instagramRuns = pgTable(
  "instagram_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Usuario de la cuenta objetivo tal como se pidió. */
    username: text("username").notNull(),
    /** Seguidores a analizar (objetivo). */
    requested: integer("requested").notNull(),
    /** Tope de intentos, incluida la resolución. Solo puede ampliarse. */
    budgetMaxCalls: integer("budget_max_calls").notNull(),
    /** Consultar el perfil de cada seguidor público seleccionado (mismo presupuesto). */
    enrichProfiles: boolean("enrich_profiles").notNull().default(false),
    /** Intentos reservados hasta ahora (todos ocupan presupuesto). */
    attemptCount: integer("attempt_count").notNull().default(0),
    /** Páginas confirmadas: el siguiente page_no es page_count + 1. */
    pageCount: integer("page_count").notNull().default(0),
    /** Seguidores únicos guardados: el siguiente ord es unique_count + 1. */
    uniqueCount: integer("unique_count").notNull().default(0),
    /** Token de cercado: sube al reconciliar un intento como "uncertain". */
    epoch: integer("epoch").notNull().default(0),
    /** Sube con cada cambio confirmado; el cierre se condiciona a ella. */
    revision: integer("revision").notNull().default(0),
    /** not_started | open | limited | exhausted | cursor_repeated | cursor_cycle. */
    listState: text("list_state").notNull().default("not_started"),
    /** Último cursor recibido, opaco y sin normalizar. */
    cursor: text("cursor"),
    /** Cuenta resuelta (todas null hasta la resolución). */
    targetPk: text("target_pk"),
    targetUsername: text("target_username"),
    targetFollowerCount: integer("target_follower_count"),
    targetIsPrivate: boolean("target_is_private"),
    targetIsVerified: boolean("target_is_verified"),
    /** Resultado vigente; se invalida (null) al aceptar una nueva reserva. */
    outcome: jsonb("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("instagram_runs_requested_check", sql`${t.requested} > 0`),
    check("instagram_runs_budget_check", sql`${t.budgetMaxCalls} > 0`),
    check(
      "instagram_runs_counters_check",
      sql`${t.attemptCount} >= 0 and ${t.pageCount} >= 0 and ${t.uniqueCount} >= 0 and ${t.epoch} >= 0 and ${t.revision} >= 0`,
    ),
    // El presupuesto también lo garantiza la base: reservar incrementa attempt_count.
    check("instagram_runs_attempts_within_budget", sql`${t.attemptCount} <= ${t.budgetMaxCalls}`),
    // Cada página confirmada consumió un intento.
    check("instagram_runs_pages_within_attempts", sql`${t.pageCount} <= ${t.attemptCount}`),
    check(
      "instagram_runs_list_state_check",
      sql`${t.listState} in ('not_started', 'open', 'limited', 'exhausted', 'cursor_repeated', 'cursor_cycle')`,
    ),
    check(
      "instagram_runs_target_check",
      sql`(${t.targetPk} is null and ${t.targetUsername} is null and ${t.targetFollowerCount} is null and ${t.targetIsPrivate} is null and ${t.targetIsVerified} is null) or (${t.targetPk} is not null and ${t.targetUsername} is not null and ${t.targetIsPrivate} is not null and ${t.targetIsVerified} is not null)`,
    ),
  ],
);

/** Un intento = una llamada a la fuente con su propia reserva de presupuesto. */
export const instagramAttempts = pgTable(
  "instagram_attempts",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => instagramRuns.id, { onDelete: "cascade" }),
    /** 1..n dentro de la ejecución. */
    attemptNo: integer("attempt_no").notNull(),
    /** resolve | page | profile. */
    kind: text("kind").notNull(),
    /**
     * Cursor solicitado, íntegro y opaco: es el valor que se reenvía al proveedor y el único
     * lugar donde se guarda. null en la resolución y en la primera página (las distingue
     * `kind`); "null" y "" son cursores de texto distintos de null.
     */
    requestCursor: text("request_cursor"),
    /** ID del seguidor cuyo perfil se consulta (solo en intentos `profile`). */
    profilePk: text("profile_pk"),
    /** SHA-256 de la operación (ver INSTAGRAM_OPERATION_KEY_SQL); ligado por CHECK. */
    operationKey: bytea("operation_key").notNull(),
    /** reserved | succeeded | failed | uncertain. */
    status: text("status").notNull().default("reserved"),
    /** Epoch de la ejecución al reservar. */
    epoch: integer("epoch").notNull(),
    error: text("error"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: "instagram_attempts_pk", columns: [t.runId, t.attemptNo] }),
    // Destino de la FK compuesta de instagram_pages (misma ejecución, intento, clase y operación).
    unique("instagram_attempts_run_attempt_kind_key_uq").on(
      t.runId,
      t.attemptNo,
      t.kind,
      t.operationKey,
    ),
    // Una operación tiene como máximo una reserva activa por ejecución.
    uniqueIndex("instagram_attempts_active_operation_uq")
      .on(t.runId, t.operationKey)
      .where(sql`${t.status} = 'reserved'`),
    // La cuenta se resuelve con éxito una sola vez por ejecución.
    uniqueIndex("instagram_attempts_resolved_once_uq")
      .on(t.runId)
      .where(sql`${t.kind} = 'resolve' and ${t.status} = 'succeeded'`),
    check("instagram_attempts_attempt_no_check", sql`${t.attemptNo} > 0`),
    check("instagram_attempts_kind_check", sql`${t.kind} in ('resolve', 'page', 'profile')`),
    // Solo una página lleva cursor; solo una consulta de perfil lleva el ID del seguidor.
    check(
      "instagram_attempts_resolve_cursor_check",
      sql`${t.kind} = 'page' or ${t.requestCursor} is null`,
    ),
    check(
      "instagram_attempts_profile_pk_check",
      sql`(${t.kind} = 'profile') = (${t.profilePk} is not null)`,
    ),
    // La clave es exactamente el hash del cursor guardado: no puede apuntar a otra operación.
    check(
      "instagram_attempts_operation_key_check",
      sql`${t.operationKey} = ${sql.raw(INSTAGRAM_OPERATION_KEY_SQL)}`,
    ),
    check(
      "instagram_attempts_status_check",
      sql`${t.status} in ('reserved', 'succeeded', 'failed', 'uncertain')`,
    ),
    check(
      "instagram_attempts_error_check",
      sql`(${t.status} = 'failed') = (${t.error} is not null)`,
    ),
    check(
      "instagram_attempts_finished_check",
      sql`(${t.status} = 'reserved') = (${t.finishedAt} is null)`,
    ),
  ],
);

/**
 * Página confirmada, junto con el intento que la obtuvo. No guarda el cursor solicitado: se
 * deriva del intento (`instagram_attempts.request_cursor`), así que no puede contradecirlo.
 */
export const instagramPages = pgTable(
  "instagram_pages",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => instagramRuns.id, { onDelete: "cascade" }),
    pageNo: integer("page_no").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    /** Siempre 'page': fija por FK que el intento referenciado es de página. */
    attemptKind: text("attempt_kind").notNull().default("page"),
    /** Copia de la clave del intento, impuesta por la FK; base de la unicidad por página. */
    operationKey: bytea("operation_key").notNull(),
    /** Cursor devuelto por la fuente, íntegro; null si no ofrece continuación. */
    nextCursor: text("next_cursor"),
    /** La fuente declaró la lista limitada. */
    limited: boolean("limited").notNull(),
    received: integer("received").notNull(),
    newUnique: integer("new_unique").notNull(),
    duplicates: integer("duplicates").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "instagram_pages_pk", columns: [t.runId, t.pageNo] }),
    // El intento es de la misma ejecución, es de página y reservó exactamente esta operación.
    foreignKey({
      name: "instagram_pages_attempt_fk",
      columns: [t.runId, t.attemptNo, t.attemptKind, t.operationKey],
      foreignColumns: [
        instagramAttempts.runId,
        instagramAttempts.attemptNo,
        instagramAttempts.kind,
        instagramAttempts.operationKey,
      ],
    }).onDelete("cascade"),
    // Una página se confirma una sola vez, y cada intento confirma como mucho una página.
    unique("instagram_pages_run_operation_uq").on(t.runId, t.operationKey),
    unique("instagram_pages_run_attempt_uq").on(t.runId, t.attemptNo),
    check("instagram_pages_page_no_check", sql`${t.pageNo} > 0`),
    check("instagram_pages_attempt_kind_check", sql`${t.attemptKind} = 'page'`),
    check(
      "instagram_pages_counts_check",
      sql`${t.received} >= 0 and ${t.newUnique} >= 0 and ${t.duplicates} >= 0 and ${t.received} = ${t.newUnique} + ${t.duplicates}`,
    ),
  ],
);

/**
 * Seguidor único dentro de una ejecución, en orden de primera aparición.
 * Datos personales mínimos: id, usuario y privacidad observada.
 */
export const instagramRunFollowers = pgTable(
  "instagram_run_followers",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => instagramRuns.id, { onDelete: "cascade" }),
    /** Identificador estable del seguidor en la fuente. */
    followerPk: text("follower_pk").notNull(),
    /** Posición de primera aparición (1..n). */
    ord: integer("ord").notNull(),
    username: text("username").notNull(),
    /** Privado si alguna observación de esta ejecución lo marcó privado. */
    isPrivate: boolean("is_private").notNull(),
    /** Las observaciones del mismo ID no coincidieron en privacidad. */
    privacyConflict: boolean("privacy_conflict").notNull().default(false),
    firstPageNo: integer("first_page_no").notNull(),
    /** pending | done | private | not_found (ver el núcleo). Un privado nunca queda pendiente. */
    enrichment: text("enrichment").notNull().default("pending"),
    /** Intento que consultó su perfil (null si no se consultó). */
    enrichedAttemptNo: integer("enriched_attempt_no"),
  },
  (t) => [
    primaryKey({ name: "instagram_run_followers_pk", columns: [t.runId, t.followerPk] }),
    unique("instagram_run_followers_run_ord_uq").on(t.runId, t.ord),
    foreignKey({
      name: "instagram_run_followers_page_fk",
      columns: [t.runId, t.firstPageNo],
      foreignColumns: [instagramPages.runId, instagramPages.pageNo],
    }).onDelete("cascade"),
    check("instagram_run_followers_ord_check", sql`${t.ord} > 0`),
    // Un conflicto de privacidad siempre deja al seguidor como privado.
    check(
      "instagram_run_followers_conflict_check",
      sql`not ${t.privacyConflict} or ${t.isPrivate}`,
    ),
    foreignKey({
      name: "instagram_run_followers_enriched_attempt_fk",
      columns: [t.runId, t.enrichedAttemptNo],
      foreignColumns: [instagramAttempts.runId, instagramAttempts.attemptNo],
    }),
    check(
      "instagram_run_followers_enrichment_check",
      sql`${t.enrichment} in ('pending', 'done', 'private', 'not_found')`,
    ),
    // Un seguidor privado nunca queda pendiente de consultar.
    check(
      "instagram_run_followers_private_check",
      sql`not (${t.isPrivate} and ${t.enrichment} = 'pending')`,
    ),
    // Consultado (done / not_found) ⇔ hay intento; pendiente ⇒ no lo hay.
    check(
      "instagram_run_followers_enriched_attempt_check",
      sql`(${t.enrichment} in ('done', 'not_found') and ${t.enrichedAttemptNo} is not null) or (${t.enrichment} = 'pending' and ${t.enrichedAttemptNo} is null) or ${t.enrichment} = 'private'`,
    ),
  ],
);

/**
 * Contacto publicado en el perfil de un seguidor (botón comercial o biografía), con su
 * procedencia. Datos personales: sin borrado automático por decisión del responsable; se
 * eliminan en cascada con la ejecución o el seguidor.
 */
export const instagramFollowerContacts = pgTable(
  "instagram_follower_contacts",
  {
    runId: uuid("run_id").notNull(),
    followerPk: text("follower_pk").notNull(),
    /** email | phone. */
    kind: text("kind").notNull(),
    /** Valor normalizado (correo en minúsculas; teléfono en dígitos, con + si es internacional). */
    value: text("value").notNull(),
    /** Texto tal como apareció en el perfil. */
    original: text("original").notNull(),
    /** button | biography. */
    source: text("source").notNull(),
    /** Intento (consulta del perfil) que lo observó. */
    attemptNo: integer("attempt_no").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "instagram_follower_contacts_pk",
      columns: [t.runId, t.followerPk, t.kind, t.value],
    }),
    foreignKey({
      name: "instagram_follower_contacts_follower_fk",
      columns: [t.runId, t.followerPk],
      foreignColumns: [instagramRunFollowers.runId, instagramRunFollowers.followerPk],
    }).onDelete("cascade"),
    foreignKey({
      name: "instagram_follower_contacts_attempt_fk",
      columns: [t.runId, t.attemptNo],
      foreignColumns: [instagramAttempts.runId, instagramAttempts.attemptNo],
    }).onDelete("cascade"),
    check("instagram_follower_contacts_kind_check", sql`${t.kind} in ('email', 'phone')`),
    check("instagram_follower_contacts_source_check", sql`${t.source} in ('button', 'biography')`),
    check("instagram_follower_contacts_value_check", sql`${t.value} <> ''`),
  ],
);
