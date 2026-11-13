import { randomUUID } from "node:crypto";
import { auditLog, type DbExecutor, searchRuns, withTransaction } from "@icmspy/db";
import {
  QUEUES,
  type SearchCriteria,
  type SearchRunDto,
  type SearchRunStats,
} from "@icmspy/shared";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type pg from "pg";
import type { Queue } from "../../lib/queue";
import { adapters } from "../discovery/adapters";
import type { SourceAdapter } from "../discovery/ports/source-adapter";
import { criteriaOf, hasResultList, planSearch, type SearchPlan, sourcesOf } from "./presets";

type SearchRunRow = typeof searchRuns.$inferSelect;

/** Tiempo máximo de un intento antes de que pg-boss lo dé por vencido y lo reintente. */
const IMPORT_EXPIRE_SECONDS = 15 * 60;

export function toSearchRunDto(row: SearchRunRow): SearchRunDto {
  return {
    id: row.id,
    criteria: criteriaOf(row.query),
    sources: sourcesOf(row.query, row.adapter).map((key) => ({
      key,
      name: adapters.find((a) => a.key === key)?.name ?? key,
      coverage: adapters.find((a) => a.key === key)?.searchCoverage ?? null,
    })),
    status: row.status,
    foundCount: row.foundCount,
    newCount: row.newCount,
    stats: row.stats as SearchRunStats,
    error: row.error,
    hasResults: hasResultList(row.query),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isActiveRunConflict(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const pgErr = e as { code?: string; constraint?: string };
    if (pgErr.code === "23505" && pgErr.constraint === "search_runs_active_uq") return true;
  }
  return false;
}

async function findActiveRun(db: DbExecutor, { adapter, query }: SearchPlan) {
  const [row] = await db
    .select()
    .from(searchRuns)
    .where(
      and(
        eq(searchRuns.adapter, adapter),
        sql`${searchRuns.query} = ${JSON.stringify(query)}::jsonb`,
        inArray(searchRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return row;
}

interface Deps {
  db: DbExecutor;
  pool: pg.Pool;
  queue: Queue;
  /** Registro de fuentes; por defecto, el de la aplicación. */
  registry?: readonly SourceAdapter[];
}

/**
 * Crea la ejecución y encola su job en la MISMA transacción de PostgreSQL:
 * Drizzle y pg-boss escriben por el mismo cliente, así que o quedan ambos o
 * ninguno. Si ya hay una ejecución pendiente o en curso con los mismos
 * criterios canónicos, se devuelve esa (lo garantiza el índice único
 * `search_runs_active_uq`, también ante dos solicitudes simultáneas).
 */
export async function createSearchRun(
  deps: Deps,
  criteria: SearchCriteria,
  userId: string,
): Promise<{ run: SearchRunRow; created: boolean }> {
  const plan = planSearch(criteria, deps.registry);
  const { adapter, query } = plan;
  const active = await findActiveRun(deps.db, plan);
  if (active) {
    const current = await reconcileRun(deps, active);
    if (current.status === "queued" || current.status === "running") {
      return { run: current, created: false };
    }
  }

  try {
    return await withTransaction(deps.pool, async (tx, client) => {
      const jobId = randomUUID();
      const [run] = await tx
        .insert(searchRuns)
        .values({ adapter, query, createdBy: userId, jobId })
        .returning();
      if (!run) throw new Error("No se pudo crear la búsqueda");
      const sent = await deps.queue.send(
        QUEUES.importDataset,
        { adapter, searchRunId: run.id },
        { client, id: jobId, expireInSeconds: IMPORT_EXPIRE_SECONDS },
      );
      if (sent !== jobId) throw new Error("La cola no aceptó la búsqueda");
      await tx.insert(auditLog).values({
        userId,
        action: "search_run.create",
        entity: "search_run",
        entityId: run.id,
        diff: { criteria: query },
      });
      return { run, created: true };
    });
  } catch (err) {
    if (!isActiveRunConflict(err)) throw err;
    const winner = await findActiveRun(deps.db, plan);
    if (!winner) throw err;
    return { run: winner, created: false };
  }
}

/**
 * Si el job ya terminó en pg-boss (o desapareció) pero la ejecución sigue
 * pendiente o en curso, el worker murió sin poder registrar el resultado: se
 * marca como fallida en vez de mostrar un progreso que no existe. El UPDATE
 * condicionado a `updated_at` evita pisar un cierre legítimo concurrente.
 */
export async function reconcileRun(
  deps: Pick<Deps, "db" | "queue">,
  row: SearchRunRow,
): Promise<SearchRunRow> {
  if (row.status !== "queued" && row.status !== "running") return row;
  if (!row.jobId) return row;
  const state = await deps.queue.getJobState(QUEUES.importDataset, row.jobId);
  if (state && state !== "failed" && state !== "cancelled" && state !== "completed") return row;
  const [updated] = await deps.db
    .update(searchRuns)
    .set({
      status: "failed",
      error: "La búsqueda se interrumpió antes de terminar (el proceso de fondo se detuvo).",
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(searchRuns.id, row.id),
        inArray(searchRuns.status, ["queued", "running"]),
        // PostgreSQL guarda microsegundos y Date solo milisegundos: se compara con 1 ms de margen.
        lte(searchRuns.updatedAt, new Date(row.updatedAt.getTime() + 1)),
      ),
    )
    .returning();
  if (updated) return updated;
  const [current] = await deps.db.select().from(searchRuns).where(eq(searchRuns.id, row.id));
  return current ?? row;
}

export async function getSearchRun(deps: Pick<Deps, "db" | "queue">, id: string) {
  const [row] = await deps.db.select().from(searchRuns).where(eq(searchRuns.id, id));
  return row ? reconcileRun(deps, row) : null;
}

/**
 * Últimas ejecuciones, la más reciente primero. Incluye las de la búsqueda
 * fija anterior ("IPS y clínicas de Quindío"), que conservan su historial.
 */
export async function listSearchRuns(deps: Pick<Deps, "db" | "queue">, limit: number) {
  const rows = await deps.db
    .select()
    .from(searchRuns)
    .orderBy(desc(searchRuns.createdAt), desc(searchRuns.id))
    .limit(limit);
  return Promise.all(rows.map((r) => reconcileRun(deps, r)));
}

// --- Transiciones que hace el worker -------------------------------------

export async function loadRun(db: DbExecutor, id: string) {
  const [row] = await db.select().from(searchRuns).where(eq(searchRuns.id, id));
  return row ?? null;
}

/**
 * Resultado de `startAttempt`:
 * - `started`: el intento tomó la ejecución.
 * - `closed`: la ejecución ya terminó (done o failed); no se reabre.
 * - `superseded`: ya hay registrado un intento posterior; este es viejo y no
 *   debe tocar nada.
 */
export type StartAttemptResult = "started" | "closed" | "superseded";

/**
 * Empieza un intento. Los contadores se reinician: un reintento no suma sobre
 * el anterior. Solo actúa sobre una ejecución pendiente o en curso (nunca
 * reabre una cerrada) y con un número de intento igual o mayor que el
 * registrado: un intento viejo que llega tarde no pisa al vigente. Si no la
 * toma, la ejecución queda exactamente como estaba.
 */
export async function startAttempt(
  db: DbExecutor,
  id: string,
  stats: SearchRunStats,
): Promise<StartAttemptResult> {
  const attempt = stats.attempt ?? 0;
  const rows = await db
    .update(searchRuns)
    .set({
      status: "running",
      startedAt: sql`now()`,
      finishedAt: null,
      error: null,
      foundCount: 0,
      newCount: 0,
      stats,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(searchRuns.id, id),
        inArray(searchRuns.status, ["queued", "running"]),
        sql`coalesce((${searchRuns.stats}->>'attempt')::int, 0) <= ${attempt}`,
      ),
    )
    .returning({ id: searchRuns.id });
  if (rows.length > 0) return "started";
  const [current] = await db
    .select({ status: searchRuns.status })
    .from(searchRuns)
    .where(eq(searchRuns.id, id));
  if (!current) throw new Error(`La búsqueda ${id} no existe`);
  return current.status === "queued" || current.status === "running" ? "superseded" : "closed";
}

/**
 * Bloquea la fila de la ejecución hasta el final de la transacción. Así el
 * cierre y los datos se confirman juntos y nadie la cambia entre medias.
 */
export async function lockRun(tx: DbExecutor, id: string) {
  const [row] = await tx.select().from(searchRuns).where(eq(searchRuns.id, id)).for("update");
  return row ?? null;
}

/** Solo el intento vigente escribe: uno ya reemplazado por pg-boss no pisa al nuevo. */
function isCurrentAttempt(attempt: number | undefined) {
  return sql`coalesce((${searchRuns.stats}->>'attempt')::int, 0) = ${attempt ?? 0}`;
}

export async function reportProgress(db: DbExecutor, id: string, stats: SearchRunStats) {
  await db
    .update(searchRuns)
    .set({ stats, updatedAt: sql`now()` })
    .where(
      and(eq(searchRuns.id, id), eq(searchRuns.status, "running"), isCurrentAttempt(stats.attempt)),
    );
}

/**
 * Cierra la ejecución como terminada. Debe llamarse en la misma transacción
 * que incorporó los datos (ver `lockRun`): si este UPDATE falla, no queda
 * nada incorporado.
 */
export async function completeRun(
  tx: DbExecutor,
  id: string,
  result: { stats: SearchRunStats; foundCount: number; newCount: number },
) {
  const rows = await tx
    .update(searchRuns)
    .set({
      status: "done",
      ...result,
      error: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(searchRuns.id, id), eq(searchRuns.status, "running")))
    .returning({ id: searchRuns.id });
  if (rows.length === 0) throw new Error(`La búsqueda ${id} no estaba en curso al cerrarla`);
}

/**
 * Registra el fallo de un intento. Si quedan intentos, la ejecución vuelve a
 * "queued" con el motivo a la vista; si no, queda "failed".
 */
export async function failAttempt(
  db: DbExecutor,
  id: string,
  input: { message: string; final: boolean; stats: SearchRunStats },
) {
  const { attempt = 1, maxAttempts = 1 } = input.stats;
  await db
    .update(searchRuns)
    .set({
      status: input.final ? "failed" : "queued",
      error: input.final
        ? input.message
        : `Intento ${attempt} de ${maxAttempts} falló: ${input.message}. Se reintentará.`,
      stats: input.stats,
      finishedAt: input.final ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    // Una ejecución ya terminada conserva su resultado, y un intento reemplazado no la toca.
    .where(
      and(
        eq(searchRuns.id, id),
        inArray(searchRuns.status, ["queued", "running"]),
        isCurrentAttempt(input.stats.attempt),
      ),
    );
}
