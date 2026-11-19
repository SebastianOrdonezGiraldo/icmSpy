/**
 * Adaptador PostgreSQL de `RunStore` (Drizzle + pg).
 *
 * Cada escritura es una transacción que bloquea primero la fila de la ejecución
 * (`SELECT … FOR UPDATE`), carga solo el estado que su regla necesita, aplica la regla de
 * `rules.ts` —la misma que usa `MemoryRunStore`— y persiste la diferencia. Nunca se llama al
 * proveedor dentro de una transacción.
 *
 * Estado cargado bajo el bloqueo (además de la fila de la ejecución):
 *
 * | Operación      | Intentos                                  | Páginas    |
 * |----------------|-------------------------------------------|------------|
 * | extend         | ninguno                                   | ninguna    |
 * | reserveAttempt | reservas activas + último intento         | todas (1)  |
 * | commitResolve  | reservas activas + intento del permiso    | ninguna    |
 * | commitPage     | reservas activas + intento del permiso    | todas (2)  |
 * | failAttempt    | reservas activas + intento del permiso    | ninguna    |
 * | recoverAttempt | reservas activas + intento indicado       | ninguna    |
 * | finish         | reservas activas                          | ninguna    |
 *
 * (1) para saber si la página ya está confirmada y cuál es el cursor esperado.
 * (2) para la detección de ciclos de cursor y el número de página.
 * Las páginas confirmadas están acotadas por el presupuesto (cada una consumió un intento).
 *
 * `getHead` lee el historial completo en una transacción REPEATABLE READ de solo lectura: todas
 * sus consultas ven la misma instantánea aunque otro trabajador confirme una página a la vez.
 */
import { createHash } from "node:crypto";
import {
  instagramAttempts,
  instagramPages,
  instagramRunFollowers,
  instagramRuns,
} from "@icmspy/db";
import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import {
  applyExtend,
  applyFailure,
  applyFinish,
  applyNewRequest,
  applyPage,
  applyRecover,
  applyReserve,
  applyResolve,
  type CollectResult,
  type KnownFollower,
  type Lease,
  type OperationInProgress,
  type OperationRef,
  type PagePlan,
  pageOperation,
  pagePks,
  type RequestGuard,
  type Reservation,
  type RunHead,
  type StopDecision,
} from "./rules";
import type { RunStore } from "./store";
import type {
  Attempt,
  Cursor,
  FollowersPage,
  ListState,
  Outcome,
  PageRecord,
  Run,
  StoredFollower,
  TargetAccount,
} from "./types";

type Db = NodePgDatabase<Record<string, never>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Pasos de persistencia, en orden, dentro de la transacción de una escritura. */
export type PersistStep = "attempts" | "pages" | "followers" | "run";

export interface PgRunStoreOptions {
  /** Gancho de pruebas: se invoca tras cada paso persistido, aún dentro de la transacción. */
  afterStep?: (step: PersistStep, method: string) => void;
  /**
   * Gancho de pruebas: en una escritura, tras bloquear y cargar la ejecución. `backendPid`
   * identifica la conexión que retiene el bloqueo.
   */
  afterLock?: (method: string, backendPid: () => Promise<number>) => Promise<void>;
  /** Gancho de pruebas: en `getHead`, tras leer la fila de la ejecución y antes del resto. */
  afterHeadRow?: () => Promise<void>;
}

/**
 * Clave de operación: SHA-256 de 'R' | 'N' | 'S' || cursor (UTF-8). Debe coincidir con
 * INSTAGRAM_OPERATION_KEY_SQL; el CHECK de la base rechaza cualquier diferencia.
 */
export function operationKeyBytes(op: OperationRef): Buffer {
  const canonical = op.kind === "resolve" ? "R" : op.cursor === null ? "N" : `S${op.cursor}`;
  return createHash("sha256").update(canonical, "utf8").digest();
}

/** Operación lógica de un intento del núcleo ("resolve" o "page:<cursor en JSON>"). */
function opOf(a: Attempt): OperationRef {
  if (a.kind === "resolve") return { kind: "resolve" };
  return { kind: "page", cursor: JSON.parse(a.operation.slice("page:".length)) as Cursor | null };
}

/** Qué parte del historial carga una operación (ver la tabla del encabezado). */
interface LoadScope {
  lock: boolean;
  attempts: "all" | "active" | "none";
  /** Intento que se carga además de las reservas activas (permiso o recuperación). */
  attemptNo?: number;
  /** Carga además el último intento (para saber si la solicitud ya falló). */
  latest?: boolean;
  pages: boolean;
  afterRow?: () => Promise<void>;
}

interface Loaded {
  head: RunHead;
  /** Páginas confirmadas según la fila (aunque `head.pages` no se haya cargado). */
  pageCount: number;
}

type TxConfig = Parameters<Db["transaction"]>[1];

export class PgRunStore implements RunStore {
  private readonly db: Db;
  /** Cliente con una transacción ya abierta por el llamador (ver `inTransaction`). */
  private bound = false;

  constructor(
    pool: pg.Pool,
    private readonly options: PgRunStoreOptions = {},
  ) {
    this.db = drizzle(pool);
  }

  /**
   * Almacén que trabaja dentro de la transacción ya abierta en `client`: no emite BEGIN ni
   * COMMIT, de modo que sus escrituras se confirman o se deshacen con las del llamador (por
   * ejemplo, junto con el envío de un job de pg-boss por el mismo cliente).
   */
  static inTransaction(client: pg.PoolClient, options: PgRunStoreOptions = {}): PgRunStore {
    const store = new PgRunStore(client as unknown as pg.Pool, options);
    store.bound = true;
    return store;
  }

  private transaction<T>(fn: (tx: Tx) => Promise<T>, config?: TxConfig): Promise<T> {
    if (this.bound) return fn(this.db as unknown as Tx);
    return this.db.transaction(fn, config);
  }

  async create(run: Run): Promise<void> {
    if (run.attempts.length > 0 || run.pages.length > 0 || run.followers.length > 0) {
      throw new Error("Una ejecución nueva no puede traer intentos, páginas ni seguidores");
    }
    await this.db.insert(instagramRuns).values({
      id: run.id,
      username: run.username,
      requested: run.requested,
      budgetMaxCalls: run.budgetMaxCalls,
      epoch: run.epoch,
      revision: run.revision,
      listState: run.listState,
      cursor: run.cursor,
      ...targetColumns(run.target),
      outcome: run.outcome,
    });
  }

  getHead(runId: string): Promise<RunHead> {
    return this.transaction(
      async (tx) => {
        const { head } = await loadHead(tx, runId, {
          lock: false,
          attempts: "all",
          pages: true,
          afterRow: this.options.afterHeadRow,
        });
        return head;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  extend(runId: string, changes: { requested?: number; budgetMaxCalls?: number }): Promise<void> {
    return this.write(runId, "extend", { attempts: "none", pages: false }, (head) =>
      applyExtend(head, changes),
    );
  }

  reserveAttempt(
    runId: string,
    epoch: number,
    op: OperationRef,
    guard?: RequestGuard,
  ): Promise<Reservation> {
    return this.write(
      runId,
      "reserveAttempt",
      { attempts: "active", latest: true, pages: true },
      (head) => applyReserve(head, epoch, op, guard),
    );
  }

  commitResolve(runId: string, lease: Lease, target: TargetAccount): Promise<void> {
    return this.write(
      runId,
      "commitResolve",
      { attempts: "active", attemptNo: lease.attemptId, pages: false },
      (head) => applyResolve(head, lease, target),
    );
  }

  commitPage(runId: string, lease: Lease, page: FollowersPage): Promise<void> {
    let plan: PagePlan | null = null;
    return this.write(
      runId,
      "commitPage",
      { attempts: "active", attemptNo: lease.attemptId, pages: true },
      async (head, tx) => {
        // Solo se consultan los seguidores de esta página que ya estaban guardados.
        const pks = pagePks(page);
        const rows =
          pks.length === 0
            ? []
            : await tx
                .select({
                  pk: instagramRunFollowers.followerPk,
                  isPrivate: instagramRunFollowers.isPrivate,
                })
                .from(instagramRunFollowers)
                .where(
                  and(
                    eq(instagramRunFollowers.runId, runId),
                    inArray(instagramRunFollowers.followerPk, pks),
                  ),
                );
        const known = new Map<string, KnownFollower>(rows.map((r) => [r.pk, r]));
        plan = applyPage(head, lease, page, known);
      },
      () => plan,
    );
  }

  failAttempt(runId: string, lease: Lease, message: string): Promise<number> {
    return this.write(
      runId,
      "failAttempt",
      { attempts: "active", attemptNo: lease.attemptId, pages: false },
      (head) => applyFailure(head, lease, message),
    );
  }

  recoverAttempt(runId: string, attemptId: number): Promise<number> {
    return this.write(
      runId,
      "recoverAttempt",
      { attempts: "active", attemptNo: attemptId, pages: false },
      (head) => applyRecover(head, attemptId),
    );
  }

  finish(
    runId: string,
    epoch: number,
    decision: StopDecision,
    guard?: RequestGuard,
  ): Promise<CollectResult> {
    return this.write(runId, "finish", { attempts: "active", pages: false }, (head) =>
      applyFinish(head, epoch, decision, guard),
    );
  }

  /**
   * Abre una nueva solicitud explícita (ver `applyNewRequest`): cerca a las anteriores subiendo
   * el epoch, o devuelve `in_progress` si hay una reserva activa. No forma parte de `RunStore`:
   * la usa la entrada de la cola.
   */
  beginRequest(runId: string): Promise<OperationInProgress | null> {
    return this.write(runId, "beginRequest", { attempts: "active", pages: false }, (head) =>
      applyNewRequest(head),
    );
  }

  /** Lectura completa y coherente (con seguidores), para diagnóstico y pruebas. */
  snapshot(runId: string): Promise<Run> {
    return this.transaction(
      async (tx) => {
        const { head } = await loadHead(tx, runId, { lock: false, attempts: "all", pages: true });
        const { uniqueCount: _u, attemptCount: _a, ...fields } = head;
        const followers = await tx
          .select()
          .from(instagramRunFollowers)
          .where(eq(instagramRunFollowers.runId, runId))
          .orderBy(asc(instagramRunFollowers.ord));
        return {
          ...fields,
          followers: followers.map(
            (f): StoredFollower => ({
              pk: f.followerPk,
              username: f.username,
              isPrivate: f.isPrivate,
              privacyConflict: f.privacyConflict,
              order: f.ord,
              firstPageNo: f.firstPageNo,
            }),
          ),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * Transacción de escritura: bloquea la ejecución, carga el estado indicado, aplica la regla y
   * persiste la diferencia. Si la regla lanza (permiso inválido, epoch vencido…), no se escribe.
   */
  private write<T>(
    runId: string,
    method: string,
    scope: Omit<LoadScope, "lock" | "afterRow">,
    rule: (head: RunHead, tx: Tx) => T | Promise<T>,
    planOf: () => PagePlan | null = () => null,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      const loaded = await loadHead(tx, runId, { ...scope, lock: true });
      await this.options.afterLock?.(method, async () => {
        const r = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        return Number(r.rows[0]?.pid);
      });
      const before = snapshotOf(loaded.head, loaded.pageCount);
      const result = await rule(loaded.head, tx);
      await this.persist(tx, method, before, loaded, planOf());
      return result;
    });
  }

  private async persist(
    tx: Tx,
    method: string,
    before: Before,
    loaded: Loaded,
    plan: PagePlan | null,
  ): Promise<void> {
    const after = loaded.head;
    const runId = after.id;
    const step = (s: PersistStep) => this.options.afterStep?.(s, method);

    // 1. Intentos: nuevos (reserva) y cambios de estado (confirmación, fallo, recuperación).
    for (const a of after.attempts) {
      const prev = before.attempts.get(a.id);
      if (!prev) {
        const op = opOf(a);
        await tx.insert(instagramAttempts).values({
          runId,
          attemptNo: a.id,
          kind: a.kind,
          requestCursor: op.kind === "page" ? op.cursor : null,
          operationKey: operationKeyBytes(op),
          status: a.status,
          epoch: after.epoch,
          error: a.error ?? null,
          finishedAt: a.status === "reserved" ? null : sql`now()`,
        });
      } else if (prev.status !== a.status || prev.error !== a.error) {
        await tx
          .update(instagramAttempts)
          .set({
            status: a.status,
            error: a.error ?? null,
            finishedAt: a.status === "reserved" ? null : sql`now()`,
          })
          .where(and(eq(instagramAttempts.runId, runId), eq(instagramAttempts.attemptNo, a.id)));
      }
    }
    step("attempts");

    // 2. Páginas nuevas (el cursor solicitado vive solo en el intento).
    const newPages = after.pages.slice(before.pagesLoaded);
    for (const p of newPages) {
      await tx.insert(instagramPages).values({
        runId,
        pageNo: p.pageNo,
        attemptNo: p.attemptId,
        attemptKind: "page",
        operationKey: operationKeyBytes({ kind: "page", cursor: p.requestCursor }),
        nextCursor: p.nextCursor,
        limited: p.limited,
        received: p.received,
        newUnique: p.newUnique,
        duplicates: p.duplicates,
      });
    }
    step("pages");

    // 3. Seguidores de la página: nuevos y cambios de privacidad.
    if (plan) {
      if (plan.inserts.length > 0) {
        await tx.insert(instagramRunFollowers).values(
          plan.inserts.map((f) => ({
            runId,
            followerPk: f.pk,
            ord: f.order,
            username: f.username,
            isPrivate: f.isPrivate,
            privacyConflict: f.privacyConflict,
            firstPageNo: f.firstPageNo,
          })),
        );
      }
      if (plan.privacyConflicts.length > 0) {
        await tx
          .update(instagramRunFollowers)
          .set({ isPrivate: true, privacyConflict: true })
          .where(
            and(
              eq(instagramRunFollowers.runId, runId),
              inArray(instagramRunFollowers.followerPk, plan.privacyConflicts),
            ),
          );
      }
      step("followers");
    }

    // 4. Fila de la ejecución: contadores, cursor, estado, epoch, revisión y resultado.
    const pageCount = loaded.pageCount + newPages.length;
    if (scalarsOf(after, pageCount) !== before.scalars) {
      await tx
        .update(instagramRuns)
        .set({
          requested: after.requested,
          budgetMaxCalls: after.budgetMaxCalls,
          attemptCount: after.attemptCount,
          pageCount,
          uniqueCount: after.uniqueCount,
          epoch: after.epoch,
          revision: after.revision,
          listState: after.listState,
          cursor: after.cursor,
          ...targetColumns(after.target),
          outcome: after.outcome,
          updatedAt: sql`now()`,
        })
        .where(eq(instagramRuns.id, runId));
    }
    step("run");
  }
}

/** Lo necesario para calcular la diferencia en tiempo lineal. */
interface Before {
  attempts: Map<number, { status: Attempt["status"]; error: string | undefined }>;
  pagesLoaded: number;
  scalars: string;
}

function snapshotOf(head: RunHead, pageCount: number): Before {
  return {
    attempts: new Map(head.attempts.map((a) => [a.id, { status: a.status, error: a.error }])),
    pagesLoaded: head.pages.length,
    scalars: scalarsOf(head, pageCount),
  };
}

function scalarsOf(h: RunHead, pageCount: number): string {
  return JSON.stringify([
    h.requested,
    h.budgetMaxCalls,
    h.attemptCount,
    h.uniqueCount,
    h.epoch,
    h.revision,
    h.listState,
    h.cursor,
    h.target,
    h.outcome,
    pageCount,
  ]);
}

function targetColumns(target: TargetAccount | null) {
  return {
    targetPk: target?.pk ?? null,
    targetUsername: target?.username ?? null,
    targetFollowerCount: target ? target.followerCount : null,
    targetIsPrivate: target?.isPrivate ?? null,
    targetIsVerified: target?.isVerified ?? null,
  };
}

/** Carga la cabecera según `scope`; con `lock`, bloquea antes la fila de la ejecución. */
async function loadHead(tx: Tx, runId: string, scope: LoadScope): Promise<Loaded> {
  const query = tx.select().from(instagramRuns).where(eq(instagramRuns.id, runId));
  const [row] = scope.lock ? await query.for("update") : await query;
  if (!row) throw new Error(`No existe la ejecución ${runId}`);
  await scope.afterRow?.();

  let attemptFilter: SQL | undefined;
  if (scope.attempts === "active") {
    const extra = scope.latest ? row.attemptCount : scope.attemptNo;
    const active = eq(instagramAttempts.status, "reserved");
    attemptFilter =
      extra === undefined ? active : or(active, eq(instagramAttempts.attemptNo, extra));
  }
  const attempts =
    scope.attempts === "none"
      ? []
      : await tx
          .select({
            attemptNo: instagramAttempts.attemptNo,
            kind: instagramAttempts.kind,
            requestCursor: instagramAttempts.requestCursor,
            status: instagramAttempts.status,
            error: instagramAttempts.error,
          })
          .from(instagramAttempts)
          .where(and(eq(instagramAttempts.runId, runId), attemptFilter))
          .orderBy(asc(instagramAttempts.attemptNo));

  const pages = !scope.pages
    ? []
    : await tx
        .select({
          pageNo: instagramPages.pageNo,
          attemptNo: instagramPages.attemptNo,
          requestCursor: instagramAttempts.requestCursor,
          nextCursor: instagramPages.nextCursor,
          limited: instagramPages.limited,
          received: instagramPages.received,
          newUnique: instagramPages.newUnique,
          duplicates: instagramPages.duplicates,
        })
        .from(instagramPages)
        .innerJoin(
          instagramAttempts,
          and(
            eq(instagramAttempts.runId, instagramPages.runId),
            eq(instagramAttempts.attemptNo, instagramPages.attemptNo),
          ),
        )
        .where(eq(instagramPages.runId, runId))
        .orderBy(asc(instagramPages.pageNo));

  if (
    (scope.attempts === "all" && row.attemptCount !== attempts.length) ||
    (scope.pages && row.pageCount !== pages.length)
  ) {
    throw new Error(`Contadores incoherentes en la ejecución ${runId}`);
  }

  const head: RunHead = {
    id: row.id,
    username: row.username,
    requested: row.requested,
    budgetMaxCalls: row.budgetMaxCalls,
    target:
      row.targetPk === null
        ? null
        : {
            pk: row.targetPk,
            username: row.targetUsername as string,
            followerCount: row.targetFollowerCount,
            isPrivate: row.targetIsPrivate as boolean,
            isVerified: row.targetIsVerified as boolean,
          },
    attempts: attempts.map(
      (a): Attempt => ({
        id: a.attemptNo,
        operation: a.kind === "resolve" ? "resolve" : pageOperation(a.requestCursor),
        kind: a.kind as Attempt["kind"],
        status: a.status as Attempt["status"],
        ...(a.error !== null ? { error: a.error } : {}),
      }),
    ),
    pages: pages.map(
      (p): PageRecord => ({
        pageNo: p.pageNo,
        requestCursor: p.requestCursor,
        nextCursor: p.nextCursor,
        limited: p.limited,
        received: p.received,
        newUnique: p.newUnique,
        duplicates: p.duplicates,
        attemptId: p.attemptNo,
      }),
    ),
    cursor: row.cursor,
    listState: row.listState as ListState,
    outcome: row.outcome as Outcome | null,
    epoch: row.epoch,
    revision: row.revision,
    attemptCount: row.attemptCount,
    uniqueCount: row.uniqueCount,
  };
  return { head, pageCount: row.pageCount };
}
