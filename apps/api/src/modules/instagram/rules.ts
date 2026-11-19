/**
 * Reglas de negocio de la recolección, en un único lugar.
 *
 * Son funciones síncronas sobre la cabecera de la ejecución (`RunHead`: todo menos la lista de
 * seguidores) y, para confirmar páginas, sobre los seguidores ya conocidos de esa página. Cada
 * operación del almacén las invoca dentro de su transacción: el almacén en memoria aplica el
 * resultado a su copia; el adaptador PostgreSQL lo traducirá a INSERT/UPDATE en la misma
 * transacción. Ninguna regla espera a la red ni al proveedor.
 */
import type {
  Attempt,
  Cursor,
  FollowersPage,
  ListState,
  Outcome,
  PageRecord,
  Run,
  StopReason,
  StoredFollower,
  TargetAccount,
} from "./types";

// ── Errores y señales ─────────────────────────────────────────────────────────────────────

/** El trabajador perdió el derecho a escribir: su intento se reconcilió como incierto. */
export class LeaseLost extends Error {}

/**
 * El permiso no corresponde a la escritura pedida: otra ejecución, otra operación lógica
 * (resolución frente a página, u otro cursor) o un intento con otra operación. Es un error
 * de programación; la escritura se rechaza sin cambiar nada.
 */
export class LeaseMismatch extends Error {}

/** El cursor de continuación no puede guardarse ni reenviarse tal cual (ver `cursorDefect`). */
export class InvalidCursor extends Error {}

/**
 * Señal tipada: la resolución o la página ya está reservada por otra entrega. Quien la recibe
 * se retira sin reconciliar, sin llamar a la fuente y sin consumir presupuesto. La
 * recuperación de una reserva interrumpida es explícita (`recoverAttempt`).
 */
export interface OperationInProgress {
  kind: "in_progress";
  reserved: Array<{ attemptId: number; operation: string }>;
}

export function isInProgress(value: unknown): value is OperationInProgress {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "in_progress"
  );
}

/**
 * La decisión de cierre quedó obsoleta, no hay resultado vigente ni trabajo activo. No se
 * reintenta por iniciativa propia: hace falta una solicitud explícita (`collect`).
 */
export interface DecisionSuperseded {
  kind: "superseded";
}

/**
 * La entrega se detuvo porque su job venció (`job.signal`). No reservó nada más; si una petición
 * ya había salido y su resultado es incierto, `reserved` conserva su intento para recuperarlo.
 */
export interface DeliveryAborted {
  kind: "aborted";
  reserved: Array<{ attemptId: number; operation: string }>;
}

export type CollectResult = Outcome | OperationInProgress | DecisionSuperseded | DeliveryAborted;

/**
 * Solicitud a la que pertenece una entrega (job). Se comprueba bajo el bloqueo de la ejecución
 * en cada reserva; el epoch de la solicitud se exige en todas las escrituras.
 */
export interface RequestGuard {
  /** Revisión de la ejecución al aceptar la solicitud. */
  baseRevision: number;
  /** Intentos que ya existían al aceptarla: los posteriores son de esta solicitud. */
  baseAttempts: number;
  /**
   * Vencimiento del job. Se consulta bajo el bloqueo, justo antes de conceder la reserva: una
   * entrega que venció mientras esperaba el bloqueo no reserva ni llama.
   */
  signal?: AbortSignal;
}

// ── Estado que necesitan las reglas ───────────────────────────────────────────────────────

/**
 * Ejecución sin la lista de seguidores.
 *
 * En las escrituras, un almacén puede cargar solo parte del historial:
 * - `attempts` incluye siempre todas las reservas activas, el intento del permiso (o el que se
 *   recupera) y, en la reserva, el último intento; el total de intentos, que es lo que cuenta
 *   para el presupuesto, es `attemptCount`.
 * - `pages` está completo en las operaciones que lo usan (reserva y confirmación de página).
 * Las reglas solo consultan ese subconjunto garantizado.
 */
export type RunHead = Omit<Run, "followers"> & {
  /** Intentos reservados hasta ahora (todos ocupan presupuesto). */
  attemptCount: number;
  /** Seguidores únicos guardados. */
  uniqueCount: number;
};

export type OperationRef = { kind: "resolve" } | { kind: "page"; cursor: Cursor | null };

/**
 * Permiso para escribir el resultado de un intento. Lo emite la reserva y queda vinculado a
 * su ejecución, al intento, al epoch vigente y a la operación lógica. El cursor de una página
 * se toma siempre de aquí: no hay un segundo valor que pueda divergir.
 */
export interface Lease {
  runId: string;
  attemptId: number;
  epoch: number;
  operation: OperationRef;
}

/** Lo único que necesita el recolector para consultar al proveedor. */
export type ProviderCall =
  | { kind: "resolve"; username: string }
  | { kind: "page"; targetPk: string; cursor: Cursor | null };

export type PageSkipReason =
  | "not_resolved"
  | "target_private"
  | "list_closed"
  | "unexpected_cursor"
  | "target_reached";

export type ReserveSkip =
  | "already_resolved"
  | "already_confirmed"
  | PageSkipReason
  | OperationInProgress
  /** Otra entrega de la misma solicitud ya publicó el resultado. */
  | { kind: "published"; outcome: Outcome }
  /** Un intento de esta solicitud ya falló: la decisión es provider_error con su detalle. */
  | { kind: "request_failed"; attemptId: number; error: string; revision: number }
  /** El job venció antes de conceder la reserva. */
  | { kind: "expired" };

export type Reservation =
  | { kind: "reserved"; lease: Lease; call: ProviderCall }
  | { kind: "skip"; reason: ReserveSkip }
  | { kind: "budget"; revision: number };

export interface StopDecision {
  reason: StopReason;
  /** Revisión del estado que originó la decisión. */
  revision: number;
  detail?: string;
}

/** Cambios a aplicar en los seguidores al confirmar una página. */
export interface PagePlan {
  /** Seguidores nuevos, ya numerados en orden de primera aparición. */
  inserts: StoredFollower[];
  /** Seguidores ya conocidos observados con otra privacidad: pasan a privados con conflicto. */
  privacyConflicts: string[];
}

/** Lo que el almacén sabe de un seguidor ya guardado en esta ejecución. */
export type KnownFollower = Pick<StoredFollower, "pk" | "isPrivate">;

// ── Utilidades ────────────────────────────────────────────────────────────────────────────

export function pageOperation(cursor: Cursor | null): string {
  // JSON distingue null de cualquier texto, incluido "null": el cursor sigue siendo opaco.
  return `page:${JSON.stringify(cursor)}`;
}

export function operationKey(op: OperationRef): string {
  return op.kind === "resolve" ? "resolve" : pageOperation(op.cursor);
}

export function assertPositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} debe ser un entero positivo`);
  }
}

/**
 * Defecto de un cursor que impediría guardarlo y reenviarlo exactamente: U+0000 (PostgreSQL no
 * lo admite en `text`) o un sustituto UTF-16 aislado (no tiene representación UTF-8). No se
 * normaliza nada: un cursor válido, incluido "", "null" o U+FFFD, se conserva tal cual.
 */
export function cursorDefect(cursor: Cursor | null): string | null {
  if (cursor === null) return null;
  if (cursor.includes("\u0000")) return "contiene U+0000";
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cursor)) {
    return "contiene un sustituto UTF-16 aislado";
  }
  return null;
}

function assertEpoch(head: RunHead, epoch: number) {
  if (head.epoch !== epoch) throw new LeaseLost("La ejecución se reconcilió; escritura rechazada");
}

/**
 * Validación del permiso dentro de la operación atómica, antes de cualquier cambio:
 * 1. es de esta ejecución y de la clase de operación que se confirma (`LeaseMismatch`);
 * 2. el epoch sigue vigente y el intento sigue reservado (`LeaseLost`);
 * 3. el intento reservado es exactamente esa operación lógica, cursor incluido (`LeaseMismatch`).
 */
function assertLease(head: RunHead, lease: Lease, expected: OperationRef["kind"] | "any"): Attempt {
  if (lease.runId !== head.id) {
    throw new LeaseMismatch(`El permiso es de la ejecución ${lease.runId}, no de ${head.id}`);
  }
  if (expected !== "any" && lease.operation.kind !== expected) {
    throw new LeaseMismatch(`Se esperaba un permiso de ${expected}, no de ${lease.operation.kind}`);
  }
  assertEpoch(head, lease.epoch);
  const a = head.attempts.find((x) => x.id === lease.attemptId);
  if (a?.status !== "reserved") {
    throw new LeaseLost(`El intento ${lease.attemptId} ya no es vigente`);
  }
  if (a.kind !== lease.operation.kind || a.operation !== operationKey(lease.operation)) {
    throw new LeaseMismatch(
      `El intento ${a.id} reservó ${a.operation}, no ${operationKey(lease.operation)}`,
    );
  }
  return a;
}

/** Reservas activas (de una operación concreta o de cualquiera). */
export function inProgressOf(head: RunHead, operation: string | null): OperationInProgress | null {
  const reserved = head.attempts
    .filter((a) => a.status === "reserved" && (operation === null || a.operation === operation))
    .map((a) => ({ attemptId: a.id, operation: a.operation }));
  return reserved.length > 0 ? { kind: "in_progress", reserved } : null;
}

// ── Reglas: cada una se ejecuta dentro de una sola transacción ───────────────────────────

/** Amplía objetivo o presupuesto. Nunca los reduce. */
export function applyExtend(
  head: RunHead,
  changes: { requested?: number; budgetMaxCalls?: number },
): void {
  if (changes.requested !== undefined) {
    assertPositiveInteger(changes.requested, "El número de seguidores");
    if (changes.requested < head.requested) throw new RangeError("El objetivo no se puede reducir");
    head.requested = changes.requested;
  }
  if (changes.budgetMaxCalls !== undefined) {
    assertPositiveInteger(changes.budgetMaxCalls, "El presupuesto");
    if (changes.budgetMaxCalls < head.budgetMaxCalls) {
      throw new RangeError("El presupuesto no se puede reducir");
    }
    head.budgetMaxCalls = changes.budgetMaxCalls;
  }
  head.outcome = null;
  head.revision++;
}

/** Comprobación de la resolución. */
function resolveGate(head: RunHead): ReserveSkip | null {
  if (head.target) return "already_resolved";
  return inProgressOf(head, "resolve");
}

/** Comprobación de una página: ya confirmada, en curso o no aplicable. */
function pageGate(head: RunHead, cursor: Cursor | null): ReserveSkip | null {
  if (head.pages.some((p) => p.requestCursor === cursor)) return "already_confirmed";
  const active = inProgressOf(head, pageOperation(cursor));
  if (active) return active;
  if (!head.target) return "not_resolved";
  if (head.target.isPrivate) return "target_private";
  if (head.listState !== "not_started" && head.listState !== "open") return "list_closed";
  const expected = head.pages.length === 0 ? null : head.cursor;
  if (cursor !== expected) return "unexpected_cursor";
  if (head.uniqueCount >= head.requested) return "target_reached";
  return null;
}

/**
 * Comprobación de la operación y reserva. El límite se aplica antes de cada intento; todo
 * intento ocupa presupuesto. Una reserva aceptada invalida el resultado anterior; una
 * denegada (presupuesto) u omitida (duplicada, en curso, no aplicable) no cambia nada.
 */
export function applyReserve(
  head: RunHead,
  epoch: number,
  op: OperationRef,
  guard?: RequestGuard,
): Reservation {
  assertEpoch(head, epoch); // la solicitud sigue vigente (otra posterior sube el epoch)
  if (guard) {
    // Con el epoch vigente, solo un cierre de esta misma solicitud deja un resultado posterior
    // a su revisión base (toda reserva lo invalida y una ampliación sube el epoch o lo borra).
    if (head.outcome && head.revision > guard.baseRevision) {
      return {
        kind: "skip",
        reason: { kind: "published", outcome: structuredClone(head.outcome) },
      };
    }
    // Si el último intento es de esta solicitud y falló, la decisión ya está tomada aunque el
    // cierre no llegara a guardarse (caída entre el fallo y el cierre): no se vuelve a llamar.
    const last = head.attempts.find((a) => a.id === head.attemptCount);
    if (last && last.id > guard.baseAttempts && last.status === "failed") {
      return {
        kind: "skip",
        reason: {
          kind: "request_failed",
          attemptId: last.id,
          error: last.error ?? "fallo sin detalle",
          revision: head.revision,
        },
      };
    }
    if (guard.signal?.aborted) return { kind: "skip", reason: { kind: "expired" } };
  }
  const skip = op.kind === "resolve" ? resolveGate(head) : pageGate(head, op.cursor);
  if (skip !== null) return { kind: "skip", reason: skip };
  if (head.attemptCount >= head.budgetMaxCalls) {
    return { kind: "budget", revision: head.revision };
  }
  const id = head.attemptCount + 1;
  head.attempts.push({ id, operation: operationKey(op), kind: op.kind, status: "reserved" });
  head.attemptCount = id;
  head.outcome = null;
  head.revision++;
  const call: ProviderCall =
    op.kind === "resolve"
      ? { kind: "resolve", username: head.username }
      : { kind: "page", targetPk: (head.target as TargetAccount).pk, cursor: op.cursor };
  const operation: OperationRef = op.kind === "resolve" ? { kind: "resolve" } : { ...op };
  return { kind: "reserved", lease: { runId: head.id, attemptId: id, epoch, operation }, call };
}

/** Confirma la resolución de la cuenta. */
export function applyResolve(head: RunHead, lease: Lease, target: TargetAccount): void {
  const a = assertLease(head, lease, "resolve"); // datos tardíos no se escriben
  head.target = target;
  a.status = "succeeded";
  head.revision++;
}

/** Registra el fallo de un intento vigente. Devuelve la revisión resultante. */
export function applyFailure(head: RunHead, lease: Lease, message: string): number {
  const a = assertLease(head, lease, "any"); // un error tardío no pisa "uncertain"
  a.status = "failed";
  a.error = message;
  return ++head.revision;
}

/**
 * Reconcilia el intento indicado si sigue "reserved": pasa a "uncertain" (sigue ocupando
 * presupuesto, no avanzó el cursor) y sube el epoch. Si no, 0 y sin cambios.
 */
export function applyRecover(head: RunHead, attemptId: number): number {
  const a = head.attempts.find((x) => x.id === attemptId);
  if (a?.status !== "reserved") return 0;
  a.status = "uncertain";
  head.epoch++;
  head.revision++;
  return 1;
}

/**
 * Nueva solicitud explícita de recolección (continuación). Si hay una reserva activa devuelve
 * `in_progress` sin cambiar nada; si no, sube el epoch: los trabajadores y jobs de solicitudes
 * anteriores quedan cercados y solo la nueva puede seguir.
 */
export function applyNewRequest(head: RunHead): OperationInProgress | null {
  const active = inProgressOf(head, null);
  if (active) return active;
  head.epoch++;
  head.revision++;
  return null;
}

function nextListState(head: RunHead, cursor: Cursor | null, page: FollowersPage): ListState {
  if (page.limited) return "limited"; // se detiene aunque haya cursor
  if (page.nextCursor === null) return "exhausted";
  if (page.nextCursor === cursor) return "cursor_repeated";
  const requested = new Set(head.pages.map((p) => p.requestCursor));
  requested.add(cursor);
  if (requested.has(page.nextCursor)) return "cursor_cycle"; // p. ej. A → B → A
  return "open";
}

/** IDs de la página, para que el almacén cargue solo esos seguidores ya conocidos. */
export function pagePks(page: FollowersPage): string[] {
  return [...new Set(page.users.map((u) => u.pk))];
}

/**
 * Confirma una página: deduplica por ID (dentro de la página y frente a `known`), conserva el
 * orden de primera aparición, marca privado cualquier ID observado alguna vez como privado y
 * avanza cursor, estado de la lista, contadores e intento. Todo en la misma transacción.
 */
export function applyPage(
  head: RunHead,
  lease: Lease,
  page: FollowersPage,
  known: ReadonlyMap<string, KnownFollower>,
): PagePlan {
  const a = assertLease(head, lease, "page");
  const defect = cursorDefect(page.nextCursor);
  if (defect) throw new InvalidCursor(`Cursor de continuación inválido: ${defect}`);
  // El cursor sale de la reserva: es exactamente el que se pidió a la fuente.
  const cursor = (lease.operation as { kind: "page"; cursor: Cursor | null }).cursor;
  const pageNo = head.pages.length + 1;
  const inserts: StoredFollower[] = [];
  const fresh = new Map<string, StoredFollower>();
  const conflicts = new Set<string>();
  for (const user of page.users) {
    const old = known.get(user.pk);
    if (old) {
      if (old.isPrivate !== user.isPrivate) conflicts.add(user.pk);
      continue;
    }
    const seen = fresh.get(user.pk);
    if (seen) {
      if (seen.isPrivate !== user.isPrivate) {
        seen.isPrivate = true;
        seen.privacyConflict = true;
      }
      continue;
    }
    const stored: StoredFollower = {
      ...user,
      privacyConflict: false,
      order: head.uniqueCount + inserts.length + 1,
      firstPageNo: pageNo,
    };
    fresh.set(user.pk, stored);
    inserts.push(stored);
  }
  const record: PageRecord = {
    pageNo,
    requestCursor: cursor,
    nextCursor: page.nextCursor,
    limited: page.limited,
    received: page.users.length,
    newUnique: inserts.length,
    duplicates: page.users.length - inserts.length,
    attemptId: lease.attemptId,
  };
  head.listState = nextListState(head, cursor, page);
  head.pages.push(record);
  head.cursor = page.nextCursor;
  head.uniqueCount += inserts.length;
  a.status = "succeeded";
  head.revision++;
  return { inserts, privacyConflicts: [...conflicts] };
}

/**
 * Cierra la ejecución si el estado sigue siendo el que originó la decisión. Si quedó obsoleta,
 * sin cambiar nada: `in_progress` si hay trabajo activo, el resultado vigente si otra entrega
 * lo guardó, o `superseded`.
 */
export function applyFinish(
  head: RunHead,
  epoch: number,
  decision: StopDecision,
  guard?: RequestGuard,
): CollectResult {
  assertEpoch(head, epoch); // un trabajador cercado no cierra la ejecución
  // Si otra entrega de la misma solicitud ya cerró, se devuelve su resultado sin reescribirlo
  // (aunque la decisión se tomara con la revisión actual): resultado y revisión se conservan.
  if (guard && head.outcome && head.revision > guard.baseRevision) {
    return structuredClone(head.outcome);
  }
  if (head.revision !== decision.revision) {
    const active = inProgressOf(head, null);
    if (active) return active;
    if (head.outcome) return structuredClone(head.outcome);
    return { kind: "superseded" };
  }
  const outcome: Outcome = {
    stopReason: decision.reason,
    targetReached: head.uniqueCount >= head.requested,
    continuationAvailable: head.listState === "open" && head.cursor !== null,
    listState: head.listState,
    uniqueReceived: head.uniqueCount,
    selected: Math.min(head.uniqueCount, head.requested),
    attempts: head.attemptCount,
    declaredFollowers: head.target?.followerCount ?? null,
    ...(decision.detail ? { detail: decision.detail } : {}),
  };
  head.outcome = outcome;
  head.revision++;
  return structuredClone(outcome);
}
