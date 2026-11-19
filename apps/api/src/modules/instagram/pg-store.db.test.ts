/**
 * Integración del adaptador PostgreSQL con el recolector y el proveedor falso (datos sintéticos).
 *
 * Solo se ejecuta con INSTAGRAM_PG_TEST_URL e INSTAGRAM_PG_TEST_PORT. Antes de conectar se valida
 * el destino efectivo del controlador (`checkDisposableTarget`) y, antes de migrar, que el
 * servidor es la base prevista con PostgreSQL 16 y UTF8. Cada caso usa sus propias ejecuciones
 * (UUID): no se vacía ninguna tabla.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runMigrations } from "@icmspy/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CollectDeps,
  collect,
  createRun,
  extendRun,
  fetchPage,
  InvalidCursor,
  isInProgress,
  LeaseLost,
  LeaseMismatch,
  recoverInterrupted,
} from "./collect";
import {
  cursorTarget,
  FIRST_CURSOR,
  INVALID_CURSORS,
  invalidCursorProvider,
  VALID_CURSOR_CHAIN,
  validChainProvider,
} from "./cursor-scenarios";
import { FakeInstagramProvider, syntheticFollowers } from "./fake-provider";
import { PgRunStore } from "./pg-store";
import { checkDisposableServer, checkDisposableTarget } from "./pg-test-target";
import type { Lease, Reservation } from "./rules";
import { MemoryRunStore, type RunStore } from "./store";
import type { Cursor, FollowersPage, Run, StopReason, TargetAccount } from "./types";

const URL_ENV = process.env.INSTAGRAM_PG_TEST_URL;
const PORT_ENV = process.env.INSTAGRAM_PG_TEST_PORT;

const C25 = "Zm9v/==?p=25&x= 1";
const C50 = "  50  ";
const C75 = '{"next":"75"}';
const target: TargetAccount = {
  pk: "100000002",
  username: "cuenta_abierta_demo",
  followerCount: 8_852,
  isPrivate: false,
  isVerified: false,
};
const page = (users: FollowersPage["users"], nextCursor: Cursor | null): FollowersPage => ({
  users,
  nextCursor,
  limited: false,
});

function caseB() {
  return new FakeInstagramProvider(target, [
    { cursor: null, page: page(syntheticFollowers(1, 25), C25) },
    { cursor: C25, page: page(syntheticFollowers(26, 25), C50) },
    { cursor: C50, page: page(syntheticFollowers(51, 25), C75) },
    { cursor: C75, page: page(syntheticFollowers(76, 25), "fin") },
  ]);
}

/** Falla limpiamente si la promesa no termina a tiempo (en vez de colgar la suite). */
function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tiempo agotado (${ms} ms): ${label}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function pausedAtFinish(deps: CollectDeps, reason: StopReason) {
  const decided = deferred();
  const resume = deferred();
  return {
    deps: {
      ...deps,
      beforeFinish: async (r: StopReason) => {
        if (r !== reason) return;
        decided.resolve();
        await resume.promise;
      },
    },
    decided: decided.promise,
    resume: resume.resolve,
  };
}

function leaseOf(r: Reservation): Lease {
  if (r.kind !== "reserved") throw new Error(`Reserva no concedida: ${r.kind}`);
  return r.lease;
}

class InjectedFault extends Error {}

const describePg = URL_ENV && PORT_ENV ? describe : describe.skip;

describePg("PgRunStore contra PostgreSQL 16", () => {
  let pool: pg.Pool;
  let store: PgRunStore;
  const pools: pg.Pool[] = [];

  /** Pool propio de una conexión: su PID identifica a ese trabajador en pg_stat_activity. */
  async function singleConnection() {
    const p = new pg.Pool({ connectionString: URL_ENV as string, max: 1 });
    pools.push(p);
    const pid = Number((await p.query("select pg_backend_pid() as pid")).rows[0].pid);
    return { pool: p, pid };
  }

  /** Espera (con límite) a que `pid` quede bloqueado precisamente por `blockerPid`. */
  async function waitBlockedBy(pid: number, blockerPid: number) {
    for (let i = 0; i < 250; i++) {
      const r = await pool.query(
        "select wait_event_type, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = $1",
        [pid],
      );
      const row = r.rows[0];
      if (row?.wait_event_type === "Lock" && (row.blockers as number[]).includes(blockerPid)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`La conexión ${pid} no quedó bloqueada por ${blockerPid}`);
  }

  beforeAll(async () => {
    const url = URL_ENV as string;
    const effective = checkDisposableTarget(url, Number(PORT_ENV)); // antes de conectar
    pool = new pg.Pool({ connectionString: url, max: 10 });
    await checkDisposableServer(pool, effective); // antes de migrar
    await runMigrations(
      url,
      fileURLToPath(new URL("../../../../../packages/db/migrations", import.meta.url)),
    );
    store = new PgRunStore(pool);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await pool?.end();
  });

  async function newRun(
    s: RunStore,
    requested: number,
    budgetMaxCalls: number,
    username = target.username,
  ) {
    const id = randomUUID();
    await createRun(s, { id, username, requested, budgetMaxCalls });
    return id;
  }

  it("mismo comportamiento que MemoryRunStore (duplicados y conflicto de privacidad)", async () => {
    const [u1, u2, u3] = syntheticFollowers(1, 3);
    if (!u1 || !u2 || !u3) throw new Error("fixture");
    const pages = () =>
      new FakeInstagramProvider(target, [
        { cursor: null, page: page([u1, u3, u1], "a") },
        {
          cursor: "a",
          page: page([{ ...u1, isPrivate: true }, { ...u3, isPrivate: false }, u2], null),
        },
      ]);
    const id = randomUUID();
    const memory = new MemoryRunStore();
    for (const s of [memory, store] as RunStore[]) {
      await createRun(s, { id, username: target.username, requested: 10, budgetMaxCalls: 10 });
    }
    const outMem = await collect({ provider: pages(), store: memory }, id);
    const outPg = await collect({ provider: pages(), store }, id);
    expect(outPg).toEqual(outMem);
    expect(await store.snapshot(id)).toEqual(memory.snapshot(id));
  });

  it("getHead coherente aunque otro trabajador confirme una página durante la lectura", async () => {
    const provider = caseB();
    const id = await newRun(store, 75, 2);
    await collect({ provider, store }, id);
    await extendRun(store, id, { budgetMaxCalls: 10 });
    const lease = leaseOf(await store.reserveAttempt(id, 0, { kind: "page", cursor: C25 }));

    const reached = deferred();
    const resume = deferred();
    const reader = new PgRunStore(pool, {
      afterHeadRow: async () => {
        reached.resolve();
        await resume.promise;
      },
    });
    try {
      const headP = reader.getHead(id);
      await within(reached.promise, 10_000, "lectura de la fila");
      await within(
        store.commitPage(id, lease, await provider.followersPage(target.pk, C25)),
        10_000,
        "confirmación concurrente",
      );
      resume.resolve();
      const head = await within(headP, 10_000, "getHead");
      expect(head.pages).toHaveLength(1);
      expect(head.uniqueCount).toBe(25);
      expect(head.attempts.at(-1)).toMatchObject({ id: 3, status: "reserved" });
      const now = await store.getHead(id);
      expect(now.pages).toHaveLength(2);
      expect(now.uniqueCount).toBe(50);
    } finally {
      resume.resolve();
    }
  });

  it("1. guarda una página, otra instancia del adaptador reanuda sin repetirla", async () => {
    const first = caseB();
    const id = await newRun(store, 75, 2);
    expect(await collect({ provider: first, store }, id)).toMatchObject({
      stopReason: "budget_exhausted",
      uniqueReceived: 25,
    });
    const { pool: otherPool } = await singleConnection();
    const resumed = new PgRunStore(otherPool);
    const second = caseB();
    await extendRun(resumed, id, { budgetMaxCalls: 10 });
    expect(await collect({ provider: second, store: resumed }, id)).toMatchObject({
      stopReason: "target_reached",
      uniqueReceived: 75,
      attempts: 4,
    });
    expect(second.calls).toEqual([
      { kind: "page", cursor: C25 },
      { kind: "page", cursor: C50 },
    ]);
    const run = await resumed.snapshot(id);
    expect(run.cursor).toBe(C75);
    expect(run.pages.map((p) => p.requestCursor)).toEqual([null, C25, C50]);
    expect(run.followers.map((f) => f.pk)).toEqual(syntheticFollowers(1, 75).map((u) => u.pk));
    expect(run.followers.map((f) => f.order)).toEqual(Array.from({ length: 75 }, (_, i) => i + 1));
  });

  it("2a. entrega duplicada en curso: una reserva, un cargo y una llamada", async () => {
    const provider = caseB();
    const id = await newRun(store, 75, 10);
    const held = provider.hold(C25);
    const deps = { provider, store };
    try {
      const workerA = collect(deps, id);
      await within(held.called, 10_000, "A llega a la página 2");
      for (const r of [
        await within(collect(deps, id), 10_000, "segunda entrega"),
        await within(fetchPage(deps, id, C25), 10_000, "entrega directa"),
      ]) {
        expect(isInProgress(r) && r.reserved).toEqual([
          { attemptId: 3, operation: `page:${JSON.stringify(C25)}` },
        ]);
      }
      const counts = await pool.query(
        `select r.attempt_count, (select count(*)::int from instagram_attempts a
            where a.run_id = r.id and a.status = 'reserved') as reserved
           from instagram_runs r where r.id = $1`,
        [id],
      );
      expect(counts.rows[0]).toEqual({ attempt_count: 3, reserved: 1 });
      expect(provider.pageCalls().filter((c) => c === C25)).toHaveLength(1);
      held.release();
      expect(await within(workerA, 10_000, "A termina")).toMatchObject({
        stopReason: "target_reached",
        attempts: 4,
      });
    } finally {
      held.release();
    }
  });

  it("2a'. carrera en la reserva: la segunda conexión espera a la primera y recibe in_progress", async () => {
    const id = await newRun(store, 75, 10);
    const { epoch } = await store.getHead(id);
    const reached = deferred();
    const resume = deferred();
    let holderPid = 0;
    const first = new PgRunStore(pool, {
      afterLock: async (method, backendPid) => {
        if (method !== "reserveAttempt") return;
        holderPid = await backendPid();
        reached.resolve();
        await resume.promise; // retiene el bloqueo con la cabecera ya leída
      },
    });
    const second = await singleConnection();
    try {
      const r1 = first.reserveAttempt(id, epoch, { kind: "resolve" });
      await within(reached.promise, 10_000, "primera reserva bajo bloqueo");
      const r2 = new PgRunStore(second.pool).reserveAttempt(id, epoch, { kind: "resolve" });
      await waitBlockedBy(second.pid, holderPid);

      resume.resolve();
      expect((await within(r1, 10_000, "primera")).kind).toBe("reserved");
      const out2 = await within(r2, 10_000, "segunda");
      expect(out2.kind === "skip" && isInProgress(out2.reason)).toBe(true);
      expect(
        (await pool.query("select attempt_count from instagram_runs where id = $1", [id])).rows[0],
      ).toEqual({
        attempt_count: 1,
      });
    } finally {
      resume.resolve();
    }
  });

  it("2b. B termina mientras la conexión de A sigue bloqueada en su ejecución", async () => {
    const runA = await newRun(store, 75, 10);
    const runB = await newRun(store, 75, 10);
    const locker = await pool.connect();
    const a = await singleConnection();
    try {
      const lockerPid = Number((await locker.query("select pg_backend_pid() as pid")).rows[0].pid);
      await locker.query("begin");
      await locker.query("select id from instagram_runs where id = $1 for update", [runA]);

      let settledA = false;
      const workerA = collect({ provider: caseB(), store: new PgRunStore(a.pool) }, runA).finally(
        () => {
          settledA = true;
        },
      );
      await waitBlockedBy(a.pid, lockerPid); // A, y solo A, espera a ese bloqueo

      const outB = await within(collect({ provider: caseB(), store }, runB), 10_000, "B");
      expect(outB).toMatchObject({ stopReason: "target_reached", uniqueReceived: 75 });
      expect(settledA).toBe(false);

      await locker.query("rollback");
      expect(await within(workerA, 10_000, "A tras liberar")).toMatchObject({
        stopReason: "target_reached",
      });
    } finally {
      await locker.query("rollback").catch(() => {});
      locker.release();
    }
  }, 30_000);

  it("3. fallo dentro de commitPage tras escribir: vuelve al estado previo; la recuperación continúa", async () => {
    let armed = false;
    const faulty = new PgRunStore(pool, {
      afterStep: (step, method) => {
        if (armed && method === "commitPage" && step === "followers") {
          armed = false;
          throw new InjectedFault("fallo inyectado tras escribir intento, página y seguidores");
        }
      },
    });
    const provider = caseB();
    const id = await newRun(faulty, 75, 10);
    const held = provider.hold(C25);
    try {
      const worker = collect({ provider, store: faulty }, id);
      await within(held.called, 10_000, "reserva de la página 2");
      const before = await faulty.snapshot(id);
      armed = true;
      held.release();
      await expect(within(worker, 10_000, "trabajador")).rejects.toBeInstanceOf(InjectedFault);
      expect(await faulty.snapshot(id)).toEqual(before);

      expect(isInProgress(await collect({ provider, store: faulty }, id))).toBe(true);
      expect(await recoverInterrupted(faulty, id, 3)).toBe(1);
      expect(await collect({ provider, store: faulty }, id)).toMatchObject({
        stopReason: "target_reached",
        attempts: 5,
      });
      expect(provider.pageCalls()).toEqual([null, C25, C25, C50]);
    } finally {
      armed = false;
      held.release();
    }
  });

  describe("cursores", () => {
    it('U+FFFD, emoji, "", "null" y null: se guardan y reenvían exactamente', async () => {
      const provider = validChainProvider();
      const id = await newRun(store, 100, 10, cursorTarget.username);
      expect(await collect({ provider, store }, id)).toMatchObject({
        stopReason: "list_exhausted",
        uniqueReceived: 50,
      });
      expect(provider.pageCalls()).toEqual(VALID_CURSOR_CHAIN);
      const run = await store.snapshot(id);
      expect(run.pages.map((p) => [p.requestCursor, p.nextCursor])).toEqual(
        VALID_CURSOR_CHAIN.map((c, i) => [c, VALID_CURSOR_CHAIN[i + 1] ?? null]),
      );
      // Igual que en memoria, byte a byte.
      const memory = new MemoryRunStore();
      await createRun(memory, {
        id,
        username: cursorTarget.username,
        requested: 100,
        budgetMaxCalls: 10,
      });
      await collect({ provider: validChainProvider(), store: memory }, id);
      expect(run).toEqual(memory.snapshot(id));
    });

    for (const [label, bad, reason] of INVALID_CURSORS) {
      it(`cursor con ${label}: fallo registrado, cursor anterior intacto, sin otra llamada`, async () => {
        const provider = invalidCursorProvider(bad);
        const id = await newRun(store, 100, 10, cursorTarget.username);
        const out = await collect({ provider, store }, id);
        expect(out).toMatchObject({ stopReason: "provider_error", attempts: 3 });
        const run = await store.snapshot(id);
        expect(run.cursor).toBe(FIRST_CURSOR);
        expect(run.pages).toHaveLength(1);
        expect(run.followers).toHaveLength(25);
        expect(run.attempts[2]).toMatchObject({ status: "failed" });
        expect(run.attempts[2]?.error).toMatch(reason);
        expect(provider.calls).toHaveLength(3);

        // Directo al almacén: InvalidCursor y nada escrito.
        const lease = leaseOf(
          await store.reserveAttempt(id, 0, { kind: "page", cursor: FIRST_CURSOR }),
        );
        const before = await store.snapshot(id);
        await expect(
          store.commitPage(id, lease, { users: [], nextCursor: bad, limited: false }),
        ).rejects.toBeInstanceOf(InvalidCursor);
        expect(await store.snapshot(id)).toEqual(before);
      });
    }
  });

  describe("4. permisos, epoch y revisión", () => {
    it("permiso de otra ejecución: rechazado sin cambios; el legítimo confirma", async () => {
      const provider = caseB();
      const x = await newRun(store, 75, 10);
      const y = await newRun(store, 75, 10);
      const leases: Record<string, Lease> = {};
      for (const id of [x, y]) {
        const resolve = leaseOf(await store.reserveAttempt(id, 0, { kind: "resolve" }));
        await store.commitResolve(id, resolve, await provider.resolveAccount(target.username));
        leases[id] = leaseOf(await store.reserveAttempt(id, 0, { kind: "page", cursor: null }));
      }
      const leaseX = leases[x] as Lease;
      const leaseY = leases[y] as Lease;
      const before = [await store.snapshot(x), await store.snapshot(y)];
      const p1 = await provider.followersPage(target.pk, null);
      await expect(store.commitPage(x, leaseY, p1)).rejects.toBeInstanceOf(LeaseMismatch);
      await expect(store.failAttempt(x, leaseY, "ajeno")).rejects.toBeInstanceOf(LeaseMismatch);
      expect([await store.snapshot(x), await store.snapshot(y)]).toEqual(before);
      await store.commitPage(x, leaseX, p1);
      await store.commitPage(y, leaseY, p1);
      expect((await store.snapshot(x)).followers).toHaveLength(25);
    });

    it("epoch vencido: sus datos no se escriben; aviso duplicado sin efecto", async () => {
      const provider = caseB();
      const id = await newRun(store, 75, 10);
      const held = provider.hold(C25);
      try {
        const stale = collect({ provider, store }, id);
        await within(held.called, 10_000, "reserva");
        expect(await recoverInterrupted(store, id, 3)).toBe(1);
        const afterRecover = await store.snapshot(id);
        held.release();
        await expect(within(stale, 10_000, "trabajador vencido")).rejects.toBeInstanceOf(LeaseLost);
        expect(await recoverInterrupted(store, id, 3)).toBe(0);
        expect(await recoverInterrupted(store, id, 99)).toBe(0);
        expect(await store.snapshot(id)).toEqual(afterRecover);
        expect(await collect({ provider, store }, id)).toMatchObject({
          stopReason: "target_reached",
          attempts: 5,
        });
        expect(provider.calls).toHaveLength(5);
      } finally {
        held.release();
      }
    });

    it("revisión obsoleta tras ampliar: superseded, sin intento ni llamada", async () => {
      const provider = caseB();
      const id = await newRun(store, 75, 3);
      const a = pausedAtFinish({ provider, store }, "budget_exhausted");
      try {
        const workerA = collect(a.deps, id);
        await within(a.decided, 10_000, "A decide");
        await extendRun(store, id, { budgetMaxCalls: 4 });
        const afterExtend = await store.snapshot(id);
        a.resume();
        expect(await within(workerA, 10_000, "A")).toEqual({ kind: "superseded" });
        expect(await store.snapshot(id)).toEqual(afterExtend);
        expect(provider.calls).toHaveLength(3);
      } finally {
        a.resume();
      }
    });

    it("revisión obsoleta tras el éxito de otro: devuelve el resultado vigente", async () => {
      const provider = caseB();
      const id = await newRun(store, 75, 10);
      const a = pausedAtFinish({ provider, store }, "provider_error");
      const held = provider.hold(C25);
      try {
        const workerA = collect(a.deps, id);
        await within(held.called, 10_000, "A en la página 2");
        held.fail("HTTP 500 transitorio");
        await within(a.decided, 10_000, "A decide");
        const outB = await collect({ provider, store }, id);
        const afterB: Run = await store.snapshot(id);
        a.resume();
        expect(await within(workerA, 10_000, "A")).toEqual(outB);
        expect(await store.snapshot(id)).toEqual(afterB);
      } finally {
        a.resume();
        held.release();
      }
    });
  });

  it("operaciones tardías sobre un historial largo: filas consultadas y modificadas", async () => {
    // Pool que registra cada sentencia (tabla, filas devueltas o modificadas).
    const rec = new pg.Pool({ connectionString: URL_ENV as string, max: 2 });
    pools.push(rec);
    const log: Array<{ verb: string; table: string; rows: number; ids?: unknown[] }> = [];
    let recording = false;
    rec.on("connect", (client) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
        const res = original(...args);
        const text =
          typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
        if (recording && res instanceof Promise) {
          res.then(
            (r: pg.QueryResult) => {
              const verb = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
              const table = /(?:from|into|update)\s+"(instagram_[a-z_]+)"/i.exec(text)?.[1];
              if (!table) return;
              log.push({
                verb,
                table,
                rows: r.rowCount ?? r.rows.length,
                ...(verb === "select" && table === "instagram_attempts"
                  ? { ids: r.rows.map((row) => (Array.isArray(row) ? row[0] : row.attempt_no)) }
                  : {}),
              });
            },
            () => {},
          );
        }
        return res;
      };
    });
    const observed = new PgRunStore(rec);

    // Historial sintético: resolución + 150 intentos fallidos de la primera página.
    const id = await newRun(store, 75, 300);
    const resolve = leaseOf(await store.reserveAttempt(id, 0, { kind: "resolve" }));
    await store.commitResolve(id, resolve, target);
    for (let i = 0; i < 150; i++) {
      const l = leaseOf(await store.reserveAttempt(id, 0, { kind: "page", cursor: null }));
      await store.failAttempt(id, l, `HTTP 500 sintético ${i}`);
    }
    const live = leaseOf(await store.reserveAttempt(id, 0, { kind: "page", cursor: null }));
    expect(live.attemptId).toBe(152);
    expect(await store.recoverAttempt(id, live.attemptId)).toBe(1); // epoch 0 → 1
    const head = await store.getHead(id);
    const before = await store.snapshot(id);

    const measure = async (fn: () => Promise<unknown>) => {
      log.length = 0;
      recording = true;
      try {
        await fn().catch((e) => e);
      } finally {
        recording = false;
      }
      return [...log];
    };

    const lateFail = await measure(() => observed.failAttempt(id, live, "respuesta tardía"));
    const dupRecover = await measure(() => observed.recoverAttempt(id, live.attemptId));
    const staleFinish = await measure(() =>
      observed.finish(id, head.epoch, { reason: "provider_error", revision: 0 }),
    );
    expect(await store.snapshot(id)).toEqual(before); // ninguna modificó nada

    for (const [label, entries] of [
      ["failAttempt tardío", lateFail],
      ["recoverAttempt duplicado", dupRecover],
      ["finish con revisión obsoleta", staleFinish],
    ] as const) {
      const reads = entries.filter((e) => e.verb === "select");
      const writes = entries.filter((e) => e.verb !== "select");
      console.log(
        `${label}: ${entries.map((e) => `${e.verb} ${e.table} → ${e.rows}${e.ids ? ` ${JSON.stringify(e.ids)}` : ""}`).join("; ")}`,
      );
      expect(writes).toEqual([]);
      expect(reads.find((e) => e.table === "instagram_runs")?.rows).toBe(1);
      const attemptRows = reads.filter((e) => e.table === "instagram_attempts");
      expect(attemptRows.reduce((n, e) => n + e.rows, 0)).toBeLessThanOrEqual(1);
      expect(
        entries.some((e) => e.table === "instagram_pages" || e.table === "instagram_run_followers"),
      ).toBe(false);
    }

    // Contraste: una reserva legítima sí escribe (un intento y la fila de la ejecución).
    const reserve = await measure(() =>
      observed.reserveAttempt(id, head.epoch, { kind: "page", cursor: null }),
    );
    console.log(
      `reserveAttempt: ${reserve.map((e) => `${e.verb} ${e.table} → ${e.rows}`).join("; ")}`,
    );
    expect(reserve.filter((e) => e.verb !== "select")).toEqual([
      { verb: "insert", table: "instagram_attempts", rows: 1 },
      { verb: "update", table: "instagram_runs", rows: 1 },
    ]);
  }, 60_000);

  describe("enriquecimiento de perfiles (0006)", () => {
    const enrichTarget: TargetAccount = {
      ...target,
      pk: "100000077",
      username: "cuenta_enriquecida",
    };
    const followers = syntheticFollowers(1, 25); // n % 3 === 0 privados
    const fpk = (n: number) => String(9_000_000 + n);
    const okProfile = (
      p: Partial<{
        businessEmail: string;
        businessPhone: string;
        biography: string;
        isPrivate: boolean;
      }>,
    ) => ({
      status: "ok" as const,
      isPrivate: p.isPrivate ?? false,
      businessEmail: p.businessEmail ?? null,
      businessPhone: p.businessPhone ?? null,
      biography: p.biography ?? null,
    });
    const enrichProvider = () =>
      new FakeInstagramProvider(
        enrichTarget,
        [{ cursor: null, page: { users: followers, nextCursor: null, limited: false } }],
        undefined,
        new Map([
          [
            fpk(1),
            okProfile({
              businessEmail: "Contacto1@Negocio.example",
              businessPhone: "+57 601 555 0001",
            }),
          ],
          [
            fpk(2),
            okProfile({ biography: "Pedidos: ventas2@negocio.example · WhatsApp 300 555 0002" }),
          ],
          [fpk(5), okProfile({ isPrivate: true })],
          [fpk(7), okProfile({ biography: "Hola" })],
          [fpk(8), okProfile({})],
          [fpk(10), okProfile({ businessEmail: "info10@negocio.example" })],
        ]),
      );
    const createEnrichRun = async (s: RunStore, id: string, budgetMaxCalls = 20) =>
      createRun(s, {
        id,
        username: enrichTarget.username,
        requested: 10,
        budgetMaxCalls,
        enrichProfiles: true,
      });

    it("mismo resultado que MemoryRunStore: estados, contactos y procedencia", async () => {
      const id = randomUUID();
      const memory = new MemoryRunStore();
      await createEnrichRun(memory, id);
      await createEnrichRun(store, id);
      const outMem = await collect({ provider: enrichProvider(), store: memory }, id);
      const pgProvider = enrichProvider();
      const outPg = await collect({ provider: pgProvider, store }, id);
      expect(outPg).toEqual(outMem);
      const run = await store.snapshot(id);
      expect(run).toEqual(memory.snapshot(id));
      expect(pgProvider.profileCalls()).toEqual([1, 2, 4, 5, 7, 8, 10].map(fpk));
      expect(run.followers[0]?.contacts.map((c) => [c.kind, c.value, c.source])).toEqual([
        ["email", "contacto1@negocio.example", "button"],
        ["phone", "+576015550001", "button"],
      ]);
      const rows = await pool.query(
        "select count(*)::int as n from instagram_follower_contacts where run_id = $1",
        [id],
      );
      expect(rows.rows[0].n).toBe(5);
    });

    it("fallo dentro de commitProfile tras escribir: vuelve atrás; la recuperación continúa", async () => {
      let armed = false;
      const faulty = new PgRunStore(pool, {
        afterStep: (step, method) => {
          if (armed && method === "commitProfile" && step === "followers") {
            armed = false;
            throw new InjectedFault("fallo tras escribir el estado y los contactos");
          }
        },
      });
      const provider = enrichProvider();
      const id = randomUUID();
      await createEnrichRun(faulty, id);
      const held = provider.holdProfile(fpk(1));
      try {
        const worker = collect({ provider, store: faulty }, id);
        await within(held.called, 10_000, "consulta del perfil 1");
        const before = await faulty.snapshot(id);
        armed = true;
        held.release();
        await expect(within(worker, 10_000, "trabajador")).rejects.toBeInstanceOf(InjectedFault);
        expect(await faulty.snapshot(id)).toEqual(before);
        const reserved = before.attempts.at(-1);
        expect(reserved).toMatchObject({ kind: "profile", status: "reserved" });

        expect(await recoverInterrupted(faulty, id, reserved?.id as number)).toBe(1);
        expect(await collect({ provider, store: faulty }, id)).toMatchObject({
          stopReason: "target_reached",
        });
        const run = await faulty.snapshot(id);
        expect(run.followers[0]).toMatchObject({ enrichment: "done" });
        expect(run.followers[0]?.contacts).toHaveLength(2); // sin duplicados
        expect(provider.profileCalls().filter((p) => p === fpk(1))).toHaveLength(2);
      } finally {
        armed = false;
        held.release();
      }
    });

    it("la base rechaza un privado pendiente y una clave de perfil incorrecta", async () => {
      const id = randomUUID();
      await createEnrichRun(store, id, 2); // resolución + página, sin perfiles
      await collect({ provider: enrichProvider(), store }, id);
      const priv = pool.query(
        "update instagram_run_followers set enrichment = 'pending' where run_id = $1 and is_private",
        [id],
      );
      await expect(priv).rejects.toMatchObject({
        code: "23514",
        constraint: "instagram_run_followers_private_check",
      });
      const badKey = pool.query(
        `insert into instagram_attempts (run_id, attempt_no, kind, profile_pk, operation_key, status, epoch, finished_at)
         values ($1, 99, 'profile', $2, sha256('P0'::bytea), 'failed', 0, now())`,
        [id, fpk(1)],
      );
      await expect(badKey).rejects.toMatchObject({ code: "23514" });
    });
  });
});
