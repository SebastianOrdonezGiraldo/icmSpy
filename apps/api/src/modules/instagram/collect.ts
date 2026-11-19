/**
 * Recolección de seguidores: resuelve la cuenta, recorre páginas por cursor y registra por qué
 * se detuvo. Este módulo solo orquesta: reserva un intento, llama al proveedor fuera de toda
 * transacción y confirma o registra el fallo. Las reglas viven en `rules.ts` y cada paso
 * persistente es una operación atómica del `RunStore`.
 *
 * - Epoch: si se reconcilia un intento como "uncertain", el trabajador original recibe
 *   `LeaseLost` en cualquier escritura posterior (datos, error o cierre).
 * - Revisión: el cierre se guarda solo si el estado no cambió desde la decisión; si cambió,
 *   no se reintenta: devuelve el resultado vigente, `in_progress` o `superseded`.
 */
import {
  assertPositiveInteger,
  type CollectResult,
  cursorDefect,
  type DeliveryAborted,
  inProgressOf,
  isInProgress,
  type Lease,
  type OperationInProgress,
  type OperationRef,
  operationKey,
  type PageSkipReason,
  type RequestGuard,
  type ReserveSkip,
  type StopDecision,
} from "./rules";
import type { RunStore } from "./store";
import type { Cursor, InstagramProvider, ListState, Run, StopReason } from "./types";

export {
  type CollectResult,
  type DecisionSuperseded,
  type DeliveryAborted,
  InvalidCursor,
  isInProgress,
  LeaseLost,
  LeaseMismatch,
  type OperationInProgress,
  type PageSkipReason,
  pageOperation,
  type RunHead,
} from "./rules";

/** Caída simulada entre recibir la respuesta y guardarla (solo pruebas). */
export class SimulatedCrash extends Error {}

export interface CollectDeps {
  provider: InstagramProvider;
  store: RunStore;
  /** Gancho de pruebas: se invoca tras recibir la respuesta y antes de confirmarla. */
  beforeCommit?: (operation: string) => void;
  /** Gancho de pruebas: se invoca justo antes de pedir una reserva. */
  beforeReserve?: (operation: string) => Promise<void> | void;
  /** Gancho de pruebas: se invoca tras decidir el motivo de parada y antes de guardarlo. */
  beforeFinish?: (reason: StopReason) => Promise<void> | void;
}

export async function createRun(
  store: RunStore,
  input: { id: string; username: string; requested: number; budgetMaxCalls: number },
): Promise<void> {
  assertPositiveInteger(input.requested, "El número de seguidores");
  assertPositiveInteger(input.budgetMaxCalls, "El presupuesto");
  await store.create({
    ...input,
    target: null,
    attempts: [],
    pages: [],
    followers: [],
    cursor: null,
    listState: "not_started",
    outcome: null,
    epoch: 0,
    revision: 0,
  });
}

/** Amplía objetivo o presupuesto de una ejecución. Nunca los reduce. */
export function extendRun(
  store: RunStore,
  runId: string,
  changes: { requested?: number; budgetMaxCalls?: number },
): Promise<void> {
  return store.extend(runId, changes);
}

/**
 * Reconcilia el intento que el llamador observó como interrumpido (solo ese, y solo si sigue
 * reservado). Devuelve 1 si lo reconcilió y 0 si no cambió nada.
 */
export function recoverInterrupted(
  store: RunStore,
  runId: string,
  attemptId: number,
): Promise<number> {
  return store.recoverAttempt(runId, attemptId);
}

/** Seguidores seleccionados: los primeros `requested` en orden de primera aparición. */
export function selectedFollowers(run: Run) {
  return run.followers.slice(0, run.requested);
}

/** Seleccionados elegibles para consultar contactos: ninguna observación los marcó privados. */
export function contactEligibleFollowers(run: Run) {
  return selectedFollowers(run).filter((f) => !f.isPrivate);
}

type AttemptOutcome =
  | { kind: "ok" }
  | { kind: "skip"; reason: ReserveSkip }
  | { kind: "budget"; revision: number }
  | { kind: "error"; message: string; revision: number }
  | DeliveryAborted;

/**
 * Solicitud de una entrega de job: su epoch se exige en todas las escrituras y su revisión base
 * se comprueba bajo el bloqueo en cada reserva. `signal` es el vencimiento del job.
 */
export interface DeliveryRequest extends RequestGuard {
  epoch: number;
  signal?: AbortSignal;
}

const aborted = (reserved: DeliveryAborted["reserved"] = []): DeliveryAborted => ({
  kind: "aborted",
  reserved,
});

/** Espera la llamada salvo que el job venza antes: entonces devuelve `null` sin esperar. */
function untilAborted<T>(call: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return call;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function failure(
  store: RunStore,
  runId: string,
  lease: Lease,
  err: unknown,
): Promise<AttemptOutcome> {
  const message = err instanceof Error ? err.message : String(err);
  const revision = await store.failAttempt(runId, lease, message);
  return { kind: "error", message, revision };
}

/**
 * Un intento completo: reserva atómica, llamada al proveedor fuera de transacción y
 * confirmación atómica. Solo los errores del proveedor se registran como fallo del intento;
 * los del almacén (`LeaseLost`) o una caída se propagan.
 */
async function attempt(
  deps: CollectDeps,
  runId: string,
  epoch: number,
  op: OperationRef,
  request?: DeliveryRequest,
): Promise<AttemptOutcome> {
  const { store, provider } = deps;
  // Un job vencido no reserva ni llama.
  if (request?.signal?.aborted) return aborted();
  await deps.beforeReserve?.(operationKey(op));
  if (request?.signal?.aborted) return aborted();
  const r = await store.reserveAttempt(runId, epoch, op, request);
  if (r.kind !== "reserved") return r;
  const { lease, call } = r;
  // Si el job vence con la petición en curso, su resultado es incierto: la reserva queda
  // abierta (con su ID) para la recuperación explícita y no se escribe nada más.
  const inFlight = () => aborted([{ attemptId: lease.attemptId, operation: operationKey(op) }]);
  // Última comprobación antes de llamar: si venció justo tras reservar, no se llama. La reserva
  // (sin llamada) queda abierta con su ID para la recuperación explícita.
  if (request?.signal?.aborted) return inFlight();

  if (call.kind === "resolve") {
    let target: Awaited<ReturnType<InstagramProvider["resolveAccount"]>> | null;
    try {
      target = await untilAborted(provider.resolveAccount(call.username), request?.signal);
    } catch (err) {
      return failure(store, runId, lease, err);
    }
    if (target === null) return inFlight();
    deps.beforeCommit?.(operationKey(op)); // una caída aquí deja el intento "reserved"
    await store.commitResolve(runId, lease, target);
    return { kind: "ok" };
  }

  let page: Awaited<ReturnType<InstagramProvider["followersPage"]>> | null;
  try {
    page = await untilAborted(provider.followersPage(call.targetPk, call.cursor), request?.signal);
  } catch (err) {
    return failure(store, runId, lease, err);
  }
  if (page === null) return inFlight();
  // Un cursor que no se puede guardar ni reenviar exactamente invalida la respuesta: se
  // registra el fallo del intento (consumido) y no se confirma la página ni se vuelve a llamar.
  const defect = cursorDefect(page.nextCursor);
  if (defect) {
    return failure(
      store,
      runId,
      lease,
      new Error(`Cursor de continuación inválido: ${defect}; página no confirmada`),
    );
  }
  deps.beforeCommit?.(operationKey(op));
  await store.commitPage(runId, lease, page);
  return { kind: "ok" };
}

export type PageOperationResult =
  | "committed"
  | "already_confirmed"
  | "budget"
  | OperationInProgress
  | { skipped: PageSkipReason }
  | { error: string };

/**
 * Operación lógica "pedir la página con este cursor" (una entrega de job). Idempotente: si ya
 * se confirmó no llama a la fuente ni cambia contadores; si otra entrega la tiene reservada,
 * devuelve `OperationInProgress`. Tampoco llama si la cuenta es privada, la lista está
 * cerrada, el cursor no es el esperado o ya no hace falta consultar.
 */
export async function fetchPage(
  deps: CollectDeps,
  runId: string,
  requestCursor: Cursor | null,
): Promise<PageOperationResult> {
  const { epoch } = await deps.store.getHead(runId);
  const r = await attempt(deps, runId, epoch, { kind: "page", cursor: requestCursor });
  switch (r.kind) {
    case "ok":
      return "committed";
    case "budget":
      return "budget";
    case "error":
      return { error: r.message };
    case "skip":
      if (r.reason === "already_confirmed" || isInProgress(r.reason)) return r.reason;
      if (typeof r.reason !== "string" || r.reason === "already_resolved") {
        throw new Error("Motivo imposible fuera de una entrega de job");
      }
      return { skipped: r.reason };
    case "aborted":
      throw new Error("Motivo imposible fuera de una entrega de job");
  }
}

const LIST_STOP: Partial<Record<ListState, StopReason>> = {
  limited: "source_limited",
  exhausted: "list_exhausted",
  cursor_repeated: "cursor_repeated",
  cursor_cycle: "cursor_cycle",
};

function failureDecision(
  r: { kind: "budget"; revision: number } | { kind: "error"; message: string; revision: number },
): StopDecision {
  return r.kind === "budget"
    ? { reason: "budget_exhausted", revision: r.revision }
    : { reason: "provider_error", revision: r.revision, detail: r.message };
}

/**
 * Ejecuta (o reanuda) la recolección hasta alcanzar el objetivo o una condición de parada.
 * Si encuentra una resolución o página reservada por otra entrega, devuelve
 * `OperationInProgress` sin reconciliar, sin llamar a la fuente y sin consumir presupuesto.
 * Cada llamada es una solicitud explícita: puede reintentar tras un `provider_error` previo.
 */
export async function collect(
  deps: CollectDeps,
  runId: string,
  request?: DeliveryRequest,
): Promise<CollectResult> {
  const { store } = deps;
  const initial = await store.getHead(runId);
  const active = inProgressOf(initial, null);
  if (active) return active;
  // Una entrega de job conserva el epoch de su solicitud durante todo el recorrido.
  const epoch = request ? request.epoch : initial.epoch;

  /** Atiende un salto de reserva propio de una entrega de job. */
  const requestSkip = (reason: ReserveSkip): CollectResult | StopDecision | null => {
    if (typeof reason === "string" || isInProgress(reason)) return null;
    if (reason.kind === "published") return reason.outcome;
    if (reason.kind === "expired") return aborted();
    return { reason: "provider_error", revision: reason.revision, detail: reason.error };
  };

  for (;;) {
    const head = await store.getHead(runId);
    let decision: StopDecision;

    if (!head.target) {
      // La resolución se cuenta una sola vez: si ya hay cuenta, no se repite.
      const r = await attempt(deps, runId, epoch, { kind: "resolve" }, request);
      if (r.kind === "ok") continue;
      if (r.kind === "aborted") return r;
      if (r.kind === "skip") {
        if (isInProgress(r.reason)) return r.reason;
        const handled = requestSkip(r.reason);
        if (handled === null) continue; // otra entrega ya la resolvió
        if (!("revision" in handled && "reason" in handled)) return handled as CollectResult;
        decision = handled as StopDecision;
      } else {
        decision = failureDecision(r);
      }
    } else if (head.target.isPrivate) {
      decision = { reason: "target_private", revision: head.revision };
    } else if (head.uniqueCount >= head.requested) {
      // El excedente ya guardado cuenta antes de pedir otra página.
      decision = { reason: "target_reached", revision: head.revision };
    } else if (LIST_STOP[head.listState]) {
      decision = { reason: LIST_STOP[head.listState] as StopReason, revision: head.revision };
    } else {
      const cursor = head.pages.length === 0 ? null : head.cursor;
      const r = await attempt(deps, runId, epoch, { kind: "page", cursor }, request);
      if (r.kind === "ok") continue;
      if (r.kind === "aborted") return r;
      if (r.kind === "skip") {
        if (isInProgress(r.reason)) return r.reason;
        const handled = requestSkip(r.reason);
        if (handled !== null) {
          if (!("revision" in handled && "reason" in handled)) return handled as CollectResult;
          decision = handled as StopDecision;
          await deps.beforeFinish?.(decision.reason);
          return store.finish(runId, epoch, decision, request);
        }
        // El estado cambió entre la lectura y la reserva: se reevalúa en la siguiente vuelta.
        if (
          r.reason === "already_confirmed" ||
          r.reason === "target_reached" ||
          r.reason === "list_closed"
        ) {
          continue;
        }
        throw new Error(`Página no aplicable: ${r.reason}`);
      }
      decision = failureDecision(r);
    }

    await deps.beforeFinish?.(decision.reason);
    // Una decisión obsoleta no inicia un reintento: devuelve lo que otra entrega dejó.
    return store.finish(runId, epoch, decision, request);
  }
}
