/**
 * Recolección de Instagram en segundo plano (pg-boss + PgRunStore).
 *
 * Cada job es una SOLICITUD de recolección con `baseRevision` y `baseEpoch` (los de la ejecución
 * al encolar). Así se distingue:
 * - Reentrega del mismo job (reintento de pg-boss, entrega solapada, caída antes de confirmar
 *   el job): si la ejecución ya tiene un resultado posterior a la solicitud, se devuelve tal
 *   cual, sin reservar, sin llamar a la fuente y sin cambiar revisión ni contadores.
 * - Nueva solicitud explícita (`requestContinuation`): un job nuevo con la revisión actual; puede
 *   reintentar tras un error o seguir tras ampliar el presupuesto.
 * Si la ejecución tiene una reserva cuyo resultado se desconoce, la entrega se retira con
 * `in_progress` y conserva el ID del intento para su recuperación explícita.
 * El epoch identifica la solicitud vigente: lo suben tanto una recuperación como una nueva
 * solicitud, así que una entrega de un job anterior queda cercada y no trabaja (por ejemplo,
 * una reentrega tardía después de ampliar el presupuesto).
 */
import { randomUUID } from "node:crypto";
import { withTransaction } from "@icmspy/db";
import { type JobPayloads, QUEUES } from "@icmspy/shared";
import type pg from "pg";
import type { AppContext } from "../../context";
import type { JobAttemptInfo, Queue } from "../../lib/queue";
import {
  type CollectDeps,
  type CollectResult,
  collect,
  createRun,
  isInProgress,
  LeaseLost,
  type OperationInProgress,
} from "./collect";
import { SyntheticInstagramProvider } from "./fake-provider";
import { PgRunStore } from "./pg-store";
import type { InstagramProvider, Outcome } from "./types";

export type CollectJob = JobPayloads["instagram.collect"];

/** Tiempo máximo de un job antes de que pg-boss lo dé por vencido y lo reentregue. */
export const COLLECT_EXPIRE_SECONDS = 15 * 60;

export interface JobQueueDeps {
  pool: pg.Pool;
  queue: Pick<Queue, "send">;
}

/**
 * Crea la ejecución y encola su primer job en la MISMA transacción: si el envío falla, la
 * ejecución tampoco queda guardada.
 */
export async function startInstagramCollection(
  deps: JobQueueDeps,
  input: { username: string; requested: number; budgetMaxCalls: number },
): Promise<{ runId: string; jobId: string }> {
  return withTransaction(deps.pool, async (_tx, client) => {
    const runId = randomUUID();
    const jobId = randomUUID();
    await createRun(PgRunStore.inTransaction(client), { id: runId, ...input });
    const sent = await deps.queue.send(
      QUEUES.instagramCollect,
      { runId, baseRevision: 0, baseEpoch: 0, baseAttempts: 0 },
      { client, id: jobId, expireInSeconds: COLLECT_EXPIRE_SECONDS },
    );
    if (sent !== jobId) throw new Error("La cola no aceptó la recolección");
    return { runId, jobId };
  });
}

/**
 * Nueva solicitud explícita de continuación (opcionalmente ampliando objetivo o presupuesto).
 * Si hay una reserva activa se devuelve `in_progress` y no se encola nada. La ampliación y el
 * envío del job ocurren en la misma transacción.
 */
export async function requestContinuation(
  deps: JobQueueDeps,
  runId: string,
  changes?: { requested?: number; budgetMaxCalls?: number },
): Promise<{ kind: "queued"; jobId: string; job: CollectJob } | OperationInProgress> {
  return withTransaction(deps.pool, async (_tx, client) => {
    const store = PgRunStore.inTransaction(client);
    const active = await store.beginRequest(runId); // bloquea la ejecución y cerca lo anterior
    if (active) return active;
    if (changes) await store.extend(runId, changes);
    const head = await store.getHead(runId);
    const job: CollectJob = {
      runId,
      baseRevision: head.revision,
      baseEpoch: head.epoch,
      baseAttempts: head.attemptCount,
    };
    const jobId = randomUUID();
    const sent = await deps.queue.send(QUEUES.instagramCollect, job, {
      client,
      id: jobId,
      expireInSeconds: COLLECT_EXPIRE_SECONDS,
    });
    if (sent !== jobId) throw new Error("La cola no aceptó la continuación");
    return { kind: "queued", jobId, job };
  });
}

export type CollectJobResult =
  | CollectResult
  /** Reentrega: la solicitud ya tenía resultado; no se tocó nada. */
  | { kind: "already_done"; outcome: Outcome }
  /** La ejecución se recuperó después de esta solicitud: hace falta una nueva. */
  | { kind: "fenced"; reason: string };

/** Atiende una entrega de un job `instagram.collect`. */
export async function processCollectJob(
  deps: CollectDeps,
  job: CollectJob,
  signal?: AbortSignal,
): Promise<CollectJobResult> {
  // Comprobación rápida sin bloqueo; las decisivas se repiten bajo el bloqueo en cada reserva
  // (epoch de la solicitud, resultado ya publicado y fallo ya registrado de esta solicitud).
  const head = await deps.store.getHead(job.runId);
  if (head.epoch !== job.baseEpoch) {
    return { kind: "fenced", reason: `epoch ${head.epoch} ≠ ${job.baseEpoch} de la solicitud` };
  }
  if (head.revision > job.baseRevision && head.outcome) {
    return { kind: "already_done", outcome: head.outcome };
  }
  if (signal?.aborted) return { kind: "aborted", reserved: [] };
  try {
    return await collect(deps, job.runId, {
      epoch: job.baseEpoch,
      baseRevision: job.baseRevision,
      // Un job encolado antes de existir `baseAttempts` no lo trae: se asume 0, de modo que
      // un fallo ya registrado en la ejecución nunca se reintenta automáticamente (solo con
      // una continuación explícita, que fija la base actual).
      baseAttempts: Number.isInteger(job.baseAttempts) ? job.baseAttempts : 0,
      signal,
    });
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: "fenced", reason: err.message };
    throw err;
  }
}

export function describeJobResult(r: CollectJobResult): string {
  if ("stopReason" in r)
    return `${r.stopReason} (${r.uniqueReceived} únicos, ${r.attempts} intentos)`;
  if (isInProgress(r)) {
    return `in_progress (reservas abiertas: ${r.reserved.map((x) => x.attemptId).join(", ")})`;
  }
  if (r.kind === "already_done") return `ya resuelto: ${r.outcome.stopReason}`;
  if (r.kind === "fenced") return `cercado: ${r.reason}`;
  if (r.kind === "aborted") {
    return `vencido (reservas abiertas: ${r.reserved.map((x) => x.attemptId).join(", ") || "ninguna"})`;
  }
  return r.kind;
}

/** Handler de pg-boss. Los errores inesperados se propagan para que pg-boss reintente. */
export function createCollectHandler(deps: {
  pool: pg.Pool;
  provider: InstagramProvider;
  onResult?: (result: CollectJobResult, data: CollectJob, job: JobAttemptInfo) => void;
}) {
  const store = new PgRunStore(deps.pool);
  return async (data: CollectJob, job: JobAttemptInfo) => {
    const result = await processCollectJob({ provider: deps.provider, store }, data, job.signal);
    deps.onResult?.(result, data, job);
  };
}

/** Registra la cola en el worker según INSTAGRAM_PROVIDER. */
export async function registerInstagramJobs(ctx: AppContext) {
  if (ctx.env.INSTAGRAM_PROVIDER === "disabled") {
    console.log("[instagram.collect] desactivado (INSTAGRAM_PROVIDER=disabled)");
    return;
  }
  if (ctx.env.NODE_ENV === "production") {
    throw new Error("INSTAGRAM_PROVIDER=fake no se admite en producción");
  }
  console.log("[instagram.collect] modo local con proveedor sintético (sin red)");
  await ctx.queue.work(
    QUEUES.instagramCollect,
    createCollectHandler({
      pool: ctx.pool,
      provider: new SyntheticInstagramProvider(4, 900), // latencia simulada: progreso visible
      onResult: (result, data, job) =>
        console.log(
          `[instagram.collect] job=${job.id} run=${data.runId} intento=${job.retryCount}: ${describeJobResult(result)}`,
        ),
    }),
  );
}
