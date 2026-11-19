/**
 * Recolección de Instagram en segundo plano: pg-boss real, PgRunStore, PostgreSQL 16 desechable
 * y proveedor falso (datos sintéticos). Se omite sin INSTAGRAM_PG_TEST_URL/INSTAGRAM_PG_TEST_PORT.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runMigrations } from "@icmspy/db";
import { QUEUES } from "@icmspy/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueue, type Queue } from "../../lib/queue";
import { createRun, isInProgress, recoverInterrupted } from "./collect";
import { FakeInstagramProvider, syntheticFollowers } from "./fake-provider";
import {
  type CollectJob,
  type CollectJobResult,
  createCollectHandler,
  describeJobResult,
  processCollectJob,
  requestContinuation,
  startInstagramCollection,
} from "./jobs";
import { PgRunStore } from "./pg-store";
import { checkDisposableServer, checkDisposableTarget } from "./pg-test-target";
import type { RunStore } from "./store";
import type { Cursor, FollowersPage, InstagramProvider, TargetAccount } from "./types";

const URL_ENV = process.env.INSTAGRAM_PG_TEST_URL;
const PORT_ENV = process.env.INSTAGRAM_PG_TEST_PORT;
const C25 = "Zm9v/==?p=25&x= 1";
const C50 = "  50  ";
const C75 = '{"next":"75"}';

const page = (from: number, nextCursor: Cursor | null): FollowersPage => ({
  users: syntheticFollowers(from, 25),
  nextCursor,
  limited: false,
});

/** Proveedor del worker: enruta cada cuenta (única por prueba) a su proveedor falso. */
class RoutingProvider implements InstagramProvider {
  private byUser = new Map<string, InstagramProvider>();
  private byPk = new Map<string, InstagramProvider>();
  add(target: TargetAccount, provider: InstagramProvider) {
    this.byUser.set(target.username, provider);
    this.byPk.set(target.pk, provider);
  }
  resolveAccount(username: string) {
    const p = this.byUser.get(username);
    if (!p) throw new Error("Cuenta desconocida");
    return p.resolveAccount(username);
  }
  followersPage(pk: string, cursor: Cursor | null) {
    const p = this.byPk.get(pk);
    if (!p) throw new Error("Cuenta desconocida");
    return p.followersPage(pk, cursor);
  }
}

/** Caso B con una cuenta única: tres páginas de 25 y continuación. */
function newCase(routing: RoutingProvider, failOn?: Set<string>) {
  const target: TargetAccount = {
    pk: String(700_000_000 + Math.floor(Math.random() * 99_999_999)),
    username: `cuenta_${randomUUID().slice(0, 8)}`,
    followerCount: 8_852,
    isPrivate: false,
    isVerified: false,
  };
  const provider = new FakeInstagramProvider(
    target,
    [
      { cursor: null, page: page(1, C25) },
      { cursor: C25, page: page(26, C50) },
      { cursor: C50, page: page(51, C75) },
      { cursor: C75, page: page(76, "fin") },
    ],
    failOn,
  );
  routing.add(target, provider);
  return { target, provider };
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  label: string,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Tiempo agotado (${ms} ms): ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Falla limpiamente si la promesa no termina a tiempo. */
function within<T>(p: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tiempo agotado (${ms} ms): ${label}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const describePg = URL_ENV && PORT_ENV ? describe : describe.skip;

describePg("Instagram en segundo plano (pg-boss + PostgreSQL 16)", () => {
  let pool: pg.Pool;
  let queue: Queue;
  let store: PgRunStore;
  const routing = new RoutingProvider();
  const results: Array<{ jobId: string; retryCount: number; result: CollectJobResult }> = [];

  beforeAll(async () => {
    const url = URL_ENV as string;
    const effective = checkDisposableTarget(url, Number(PORT_ENV));
    pool = new pg.Pool({ connectionString: url, max: 10 });
    await checkDisposableServer(pool, effective);
    await runMigrations(
      url,
      fileURLToPath(new URL("../../../../../packages/db/migrations", import.meta.url)),
    );
    store = new PgRunStore(pool);
    queue = createQueue(url);
    await queue.start();
  }, 60_000);

  afterAll(async () => {
    await queue?.stop();
    await pool?.end();
  });

  const deps = () => ({ pool, queue });

  async function startWorker() {
    await queue.work(
      QUEUES.instagramCollect,
      createCollectHandler({
        pool,
        provider: routing,
        onResult: (result, _data, job) =>
          results.push({ jobId: job.id, retryCount: job.retryCount, result }),
      }),
    );
  }
  const stopWorker = () => queue.boss.offWork(QUEUES.instagramCollect);

  /** Estado persistido de la ejecución, para el informe de cada caso. */
  async function stateOf(runId: string) {
    const r = await pool.query(
      `select r.revision, r.epoch, r.cursor, r.attempt_count, r.outcome->>'stopReason' as stop,
              coalesce(array_agg(a.attempt_no order by a.attempt_no)
                filter (where a.status = 'reserved'), '{}') as reserved
         from instagram_runs r left join instagram_attempts a on a.run_id = r.id
        where r.id = $1 group by r.id`,
      [runId],
    );
    return r.rows[0] as {
      revision: number;
      epoch: number;
      cursor: string | null;
      attempt_count: number;
      stop: string | null;
      reserved: number[];
    };
  }

  async function fetchJob(jobId: string) {
    const jobs = await waitFor(
      async () => {
        const got = await queue.boss.fetch<CollectJob>(QUEUES.instagramCollect);
        return got.length > 0 ? got : null;
      },
      10_000,
      "job disponible",
    );
    expect(jobs.map((j) => j.id)).toEqual([jobId]);
    return jobs[0] as { id: string; data: CollectJob };
  }

  const jobState = (id: string) => queue.getJobState(QUEUES.instagramCollect, id);
  const report = (label: string, data: unknown) =>
    console.log(`[informe] ${label}: ${JSON.stringify(data)}`);

  describe("entrada interna: ejecución y job en la misma transacción", () => {
    it("crea la ejecución y su job juntos", async () => {
      const { target } = newCase(routing);
      const { runId, jobId } = await startInstagramCollection(deps(), {
        username: target.username,
        requested: 75,
        budgetMaxCalls: 10,
      });
      expect(await jobState(jobId)).toBe("created");
      const job = await queue.boss.getJobById<CollectJob>(QUEUES.instagramCollect, jobId);
      expect(job?.data).toEqual({ runId, baseRevision: 0, baseEpoch: 0, baseAttempts: 0 });
      expect((await stateOf(runId)).revision).toBe(0);
      // Se retira del alcance de las demás pruebas.
      await queue.boss.cancel(QUEUES.instagramCollect, jobId);
    });

    it("si el envío falla, no queda ejecución huérfana", async () => {
      const count = (username: string) =>
        pool
          .query("select count(*)::int as n from instagram_runs where username = $1", [username])
          .then((r) => r.rows[0].n as number);

      // a) La cola rechaza el envío.
      const a = `huerfana_${randomUUID().slice(0, 8)}`;
      const failing = {
        send: async () => {
          throw new Error("cola caída");
        },
      } as unknown as Queue;
      await expect(
        startInstagramCollection(
          { pool, queue: failing },
          { username: a, requested: 10, budgetMaxCalls: 3 },
        ),
      ).rejects.toThrow("cola caída");
      expect(await count(a)).toBe(0);

      // b) El job llega a insertarse por el cliente de la transacción y luego algo falla.
      const b = `huerfana_${randomUUID().slice(0, 8)}`;
      let sentId: string | null = null;
      const afterSend = {
        send: async (...args: Parameters<Queue["send"]>) => {
          sentId = await queue.send(...args);
          throw new Error("fallo tras encolar");
        },
      } as unknown as Queue;
      await expect(
        startInstagramCollection(
          { pool, queue: afterSend },
          { username: b, requested: 10, budgetMaxCalls: 3 },
        ),
      ).rejects.toThrow("fallo tras encolar");
      expect(sentId).toBeTruthy();
      expect(await count(b)).toBe(0);
      expect(await jobState(sentId as unknown as string)).toBeNull(); // el job se deshizo también
    });
  });

  describe("handler: reentrega frente a nueva solicitud", () => {
    for (const [label, budget, failOn, stop] of [
      ["target_reached", 10, undefined, "target_reached"],
      ["budget_exhausted", 2, undefined, "budget_exhausted"],
      ["provider_error", 10, new Set([JSON.stringify(C25)]), "provider_error"],
    ] as const) {
      it(`reentrega tras ${label}: conserva resultado, revisión, intentos y llamadas`, async () => {
        const { target, provider } = newCase(routing, failOn ? new Set(failOn) : undefined);
        const runId = randomUUID();
        await createRun(store, {
          id: runId,
          username: target.username,
          requested: 75,
          budgetMaxCalls: budget,
        });
        const job: CollectJob = { runId, baseRevision: 0, baseEpoch: 0, baseAttempts: 0 };
        const first = await processCollectJob({ provider, store }, job);
        expect(first).toMatchObject({ stopReason: stop });
        const before = await store.snapshot(runId);
        const calls = provider.calls.length;

        const again = await processCollectJob({ provider, store }, job);
        expect(again).toEqual({ kind: "already_done", outcome: before.outcome });
        expect(await store.snapshot(runId)).toEqual(before);
        expect(provider.calls).toHaveLength(calls);
        report(`reentrega tras ${label}`, { ...(await stateOf(runId)), calls });
      });
    }

    it("dos entregas solapadas del mismo job: una reserva, un cargo, una llamada por página", async () => {
      const { target, provider } = newCase(routing);
      const runId = randomUUID();
      await createRun(store, {
        id: runId,
        username: target.username,
        requested: 75,
        budgetMaxCalls: 10,
      });
      const job: CollectJob = { runId, baseRevision: 0, baseEpoch: 0, baseAttempts: 0 };
      const held = provider.hold(C25);
      try {
        const d1 = processCollectJob({ provider, store }, job);
        await waitFor(async () => provider.pageCalls().includes(C25), 10_000, "d1 en la página 2");
        const d2 = await processCollectJob({ provider, store }, job);
        expect(isInProgress(d2) && d2.reserved).toEqual([
          { attemptId: 3, operation: `page:${JSON.stringify(C25)}` },
        ]);
        expect(await stateOf(runId)).toMatchObject({ attempt_count: 3, reserved: [3] });
        held.release();
        expect(await d1).toMatchObject({ stopReason: "target_reached", attempts: 4 });
        expect(provider.pageCalls()).toEqual([null, C25, C50]);
        report("entregas solapadas", { ...(await stateOf(runId)), calls: provider.calls.length });
      } finally {
        held.release();
      }
    });

    it("continuación explícita: tras ampliar el presupuesto y tras un error transitorio", async () => {
      const { target, provider } = newCase(routing);
      const runId = randomUUID();
      await createRun(store, {
        id: runId,
        username: target.username,
        requested: 75,
        budgetMaxCalls: 2,
      });
      const first: CollectJob = { runId, baseRevision: 0, baseEpoch: 0, baseAttempts: 0 };
      expect(await processCollectJob({ provider, store }, first)).toMatchObject({
        stopReason: "budget_exhausted",
      });
      expect(await processCollectJob({ provider, store }, first)).toMatchObject({
        kind: "already_done",
      });

      const cont = await requestContinuation(deps(), runId, { budgetMaxCalls: 10 });
      if (cont.kind !== "queued") throw new Error("se esperaba un job nuevo");
      expect(cont.job.baseRevision).toBeGreaterThan(first.baseRevision);
      await queue.boss.cancel(QUEUES.instagramCollect, cont.jobId); // se atiende a mano
      // La reentrega del primer job ya no trabaja: la nueva solicitud la cercó.
      const callsBefore = provider.calls.length;
      expect(await processCollectJob({ provider, store }, first)).toMatchObject({ kind: "fenced" });
      expect(provider.calls).toHaveLength(callsBefore);
      const held = provider.hold(C50);
      const worker = processCollectJob({ provider, store }, cont.job);
      await waitFor(async () => provider.pageCalls().includes(C50), 10_000, "página 3");
      held.fail("HTTP 503 transitorio");
      expect(await worker).toMatchObject({ stopReason: "provider_error" });

      // Mientras haya una reserva activa no se encola nada (aquí no la hay: se reintenta).
      const retry = await requestContinuation(deps(), runId);
      if (retry.kind !== "queued") throw new Error("se esperaba un job nuevo");
      await queue.boss.cancel(QUEUES.instagramCollect, retry.jobId);
      expect(await processCollectJob({ provider, store }, retry.job)).toMatchObject({
        stopReason: "target_reached",
        uniqueReceived: 75,
      });
      expect(provider.pageCalls()).toEqual([null, C25, C50, C50]);
    });

    it("con una reserva abierta, la continuación devuelve in_progress y no encola", async () => {
      const { target, provider } = newCase(routing);
      const runId = randomUUID();
      await createRun(store, {
        id: runId,
        username: target.username,
        requested: 75,
        budgetMaxCalls: 10,
      });
      const held = provider.hold(C25);
      try {
        const d1 = processCollectJob(
          { provider, store },
          { runId, baseRevision: 0, baseEpoch: 0, baseAttempts: 0 },
        );
        await waitFor(async () => provider.pageCalls().includes(C25), 10_000, "reserva abierta");
        const before = await pool.query(
          "select count(*)::int as n from pgboss.job where name = $1",
          [QUEUES.instagramCollect],
        );
        const r = await requestContinuation(deps(), runId, { budgetMaxCalls: 20 });
        expect(isInProgress(r) && r.reserved.map((x) => x.attemptId)).toEqual([3]);
        const after = await pool.query(
          "select count(*)::int as n from pgboss.job where name = $1",
          [QUEUES.instagramCollect],
        );
        expect(after.rows[0].n).toBe(before.rows[0].n);
        held.release();
        await d1;
      } finally {
        held.release();
      }
    });
  });

  describe("worker de pg-boss real", () => {
    it("recorrido normal", async () => {
      const { target, provider } = newCase(routing);
      await startWorker();
      try {
        const { runId, jobId } = await startInstagramCollection(deps(), {
          username: target.username,
          requested: 75,
          budgetMaxCalls: 10,
        });
        await waitFor(
          async () => (await jobState(jobId)) === "completed",
          30_000,
          "job completado",
        );
        const state = await stateOf(runId);
        expect(state).toMatchObject({ stop: "target_reached", attempt_count: 4, reserved: [] });
        expect(provider.calls).toHaveLength(4);
        const mine = results.filter((r) => r.jobId === jobId);
        report("recorrido normal", {
          state,
          calls: provider.calls.length,
          deliveries: mine.map((r) => describeJobResult(r.result)),
        });
      } finally {
        await stopWorker();
      }
    }, 60_000);

    it("reinicio antes de empezar: el worker tomó el job y cayó sin hacer nada", async () => {
      const { target, provider } = newCase(routing);
      const { runId, jobId } = await startInstagramCollection(deps(), {
        username: target.username,
        requested: 75,
        budgetMaxCalls: 10,
      });
      await fetchJob(jobId); // lo toma un worker que muere antes de empezar
      await queue.boss.fail(QUEUES.instagramCollect, jobId, { reason: "caída simulada" });
      await startWorker();
      try {
        await waitFor(
          async () => (await jobState(jobId)) === "completed",
          30_000,
          "job completado",
        );
        const state = await stateOf(runId);
        expect(state).toMatchObject({ stop: "target_reached", attempt_count: 4, reserved: [] });
        expect(provider.calls).toHaveLength(4);
        const mine = results.filter((r) => r.jobId === jobId);
        expect(mine.map((r) => r.retryCount)).toEqual([1]);
        report("reinicio antes de empezar", {
          state,
          calls: provider.calls.length,
          deliveries: mine.map((r) => `${r.retryCount}: ${describeJobResult(r.result)}`),
        });
      } finally {
        await stopWorker();
      }
    }, 60_000);

    it("interrupción con una reserva abierta: se conserva su ID y la recuperación es explícita", async () => {
      const { target, provider } = newCase(routing);
      const { runId, jobId } = await startInstagramCollection(deps(), {
        username: target.username,
        requested: 75,
        budgetMaxCalls: 10,
      });
      const taken = await fetchJob(jobId);
      const held = provider.hold(C25);
      // El primer worker queda detenido en la llamada de la página 2 (como si muriera ahí).
      const dead = processCollectJob({ provider, store }, taken.data);
      try {
        await waitFor(async () => provider.pageCalls().includes(C25), 10_000, "reserva abierta");
        await queue.boss.fail(QUEUES.instagramCollect, jobId, { reason: "worker caído" });
        await startWorker();
        await waitFor(
          async () => (await jobState(jobId)) === "completed",
          30_000,
          "reentrega completada",
        );
        const redelivery = results.filter((r) => r.jobId === jobId);
        expect(redelivery).toHaveLength(1);
        expect(isInProgress(redelivery[0]?.result) && redelivery[0]?.result.reserved).toEqual([
          { attemptId: 3, operation: `page:${JSON.stringify(C25)}` },
        ]);
        const interrupted = await stateOf(runId);
        expect(interrupted).toMatchObject({ stop: null, attempt_count: 3, reserved: [3] });
        expect(provider.calls).toHaveLength(3);
        report("interrupción (tras la reentrega)", {
          state: interrupted,
          calls: provider.calls.length,
        });

        // Recuperación explícita del intento 3 y nueva solicitud.
        expect(await recoverInterrupted(store, runId, 3)).toBe(1);
        const cont = await requestContinuation(deps(), runId);
        if (cont.kind !== "queued") throw new Error("se esperaba un job nuevo");
        await waitFor(
          async () => (await jobState(cont.jobId)) === "completed",
          30_000,
          "continuación",
        );
        const final = await stateOf(runId);
        expect(final).toMatchObject({ stop: "target_reached", attempt_count: 5, reserved: [] });
        expect(provider.pageCalls()).toEqual([null, C25, C25, C50]);

        // La respuesta tardía del worker caído no escribe nada.
        held.release();
        expect(await dead).toMatchObject({ kind: "fenced" });
        expect(await stateOf(runId)).toEqual(final);
        report("interrupción (final)", { state: final, calls: provider.calls.length });
      } finally {
        held.release();
        await stopWorker();
      }
    }, 90_000);

    it("reentrega tras guardar el resultado y antes de confirmar el job", async () => {
      const { target, provider } = newCase(routing);
      const { runId, jobId } = await startInstagramCollection(deps(), {
        username: target.username,
        requested: 75,
        budgetMaxCalls: 10,
      });
      const taken = await fetchJob(jobId);
      expect(await processCollectJob({ provider, store }, taken.data)).toMatchObject({
        stopReason: "target_reached",
      });
      const saved = await store.snapshot(runId);
      await queue.boss.fail(QUEUES.instagramCollect, jobId, { reason: "caída antes de confirmar" });
      await startWorker();
      try {
        await waitFor(async () => (await jobState(jobId)) === "completed", 30_000, "reentrega");
        const mine = results.filter((r) => r.jobId === jobId);
        expect(mine.map((r) => r.result)).toEqual([
          { kind: "already_done", outcome: saved.outcome },
        ]);
        expect(await store.snapshot(runId)).toEqual(saved); // revisión, intentos y resultado
        expect(provider.calls).toHaveLength(4);
        report("reentrega tras guardar", {
          state: await stateOf(runId),
          calls: provider.calls.length,
          deliveries: mine.map((r) => `${r.retryCount}: ${describeJobResult(r.result)}`),
        });
      } finally {
        await stopWorker();
      }
    }, 60_000);
  });

  describe("regresiones de reentrega (PostgreSQL)", () => {
    function gate() {
      let release!: () => void;
      let reach!: () => void;
      const reached = new Promise<void>((r) => {
        reach = r;
      });
      const released = new Promise<void>((r) => {
        release = r;
      });
      return {
        reached,
        release,
        hook: async () => {
          reach();
          await released;
        },
      };
    }

    async function newRunJob(budgetMaxCalls = 10) {
      const c = newCase(routing);
      const runId = randomUUID();
      await createRun(store, {
        id: runId,
        username: c.target.username,
        requested: 75,
        budgetMaxCalls,
      });
      const job: CollectJob = { runId, baseRevision: 0, baseEpoch: 0, baseAttempts: 0 };
      return { ...c, runId, job };
    }

    it("1. pausa justo antes de reservar mientras se acepta una continuación: cero reservas y llamadas", async () => {
      const { provider, runId, job } = await newRunJob();
      const g = gate();
      try {
        const stale = processCollectJob({ provider, store, beforeReserve: g.hook }, job);
        await within(g.reached, "antes de reservar");
        const cont = await requestContinuation(deps(), runId); // sube el epoch
        if (cont.kind !== "queued") throw new Error("se esperaba un job nuevo");
        await queue.boss.cancel(QUEUES.instagramCollect, cont.jobId); // se atiende a mano
        const before = await stateOf(runId);
        g.release();
        expect(await within(stale, "entrega antigua")).toMatchObject({ kind: "fenced" });
        expect(await stateOf(runId)).toEqual(before);
        expect(provider.calls).toHaveLength(0);
        expect(before).toMatchObject({ epoch: 1, attempt_count: 0 });

        // El job nuevo autorizado sí continúa.
        expect(await processCollectJob({ provider, store }, cont.job)).toMatchObject({
          stopReason: "target_reached",
          attempts: 4,
        });
        const final = await stateOf(runId);
        expect(final).toMatchObject({
          epoch: 1,
          attempt_count: 4,
          cursor: C75,
          stop: "target_reached",
        });
        expect(provider.calls).toHaveLength(4);
        report("1. continuación durante la pausa", {
          stale: before,
          final,
          calls: provider.calls.length,
        });
      } finally {
        g.release();
      }
    });

    it("1b. continuación aceptada entre la comprobación de la entrega y su primera lectura", async () => {
      const { provider, runId, job } = await newRunJob();
      const g = gate();
      // Almacén que se detiene en la segunda lectura (la primera de collect, tras la comprobación).
      let reads = 0;
      const paused: RunStore = {
        create: (r) => store.create(r),
        getHead: async (id) => {
          reads++;
          if (reads === 2) await g.hook();
          return store.getHead(id);
        },
        extend: (...a) => store.extend(...a),
        reserveAttempt: (...a) => store.reserveAttempt(...a),
        commitResolve: (...a) => store.commitResolve(...a),
        commitPage: (...a) => store.commitPage(...a),
        failAttempt: (...a) => store.failAttempt(...a),
        recoverAttempt: (...a) => store.recoverAttempt(...a),
        finish: (...a) => store.finish(...a),
      };
      try {
        const stale = processCollectJob({ provider, store: paused }, job);
        await within(g.reached, "entre comprobación y lectura");
        const cont = await requestContinuation(deps(), runId);
        if (cont.kind !== "queued") throw new Error("se esperaba un job nuevo");
        await queue.boss.cancel(QUEUES.instagramCollect, cont.jobId);
        const before = await stateOf(runId);
        g.release();
        expect(await within(stale, "entrega antigua")).toMatchObject({ kind: "fenced" });
        expect(await stateOf(runId)).toEqual(before);
        expect(provider.calls).toHaveLength(0);
        expect(await processCollectJob({ provider, store }, cont.job)).toMatchObject({
          stopReason: "target_reached",
        });
        expect(provider.calls).toHaveLength(4);
      } finally {
        g.release();
      }
    });

    it("2. pausa antes de reservar mientras otra entrega del mismo job publica el resultado", async () => {
      const { provider, runId, job } = await newRunJob();
      const g = gate();
      try {
        const d1 = processCollectJob({ provider, store, beforeReserve: g.hook }, job);
        await within(g.reached, "antes de reservar");
        const out2 = await processCollectJob({ provider, store }, job);
        expect(out2).toMatchObject({ stopReason: "target_reached", attempts: 4 });
        const published = await store.snapshot(runId);
        g.release();
        expect(await within(d1, "entrega pausada")).toEqual(out2);
        expect(await store.snapshot(runId)).toEqual(published);
        expect(provider.calls).toHaveLength(4);
        report("2. resultado publicado durante la pausa", {
          ...(await stateOf(runId)),
          calls: provider.calls.length,
        });
      } finally {
        g.release();
      }
    });

    it("3. caída entre el fallo y el cierre: la reentrega conserva el fallo y su detalle", async () => {
      const { provider, runId, job } = await newRunJob();
      const g = gate();
      const held = provider.hold(C25);
      try {
        // Primera entrega: falla la página 2 y se detiene antes de cerrar («caída»).
        void processCollectJob(
          { provider, store, beforeFinish: (r) => (r === "provider_error" ? g.hook() : undefined) },
          job,
        );
        await within(held.called, "página 2");
        held.fail("HTTP 500 de la página 2");
        await within(g.reached, "entre el fallo y el cierre");
        const window = await stateOf(runId);
        expect(window).toMatchObject({ stop: null, attempt_count: 3, reserved: [], cursor: C25 });

        // Reentrega del mismo job: decide provider_error desde el intento persistido.
        const again = await processCollectJob({ provider, store }, job);
        expect(again).toMatchObject({
          stopReason: "provider_error",
          detail: "HTTP 500 de la página 2",
        });
        const afterRedelivery = await stateOf(runId);
        expect(afterRedelivery).toMatchObject({
          stop: "provider_error",
          attempt_count: 3,
          epoch: 0,
          cursor: C25,
        });
        expect(provider.calls).toHaveLength(3); // no volvió a pedir la página 2
        const run = await store.snapshot(runId);
        expect(run.attempts[2]).toMatchObject({
          status: "failed",
          error: "HTTP 500 de la página 2",
        });

        // Una continuación explícita sí reintenta con el presupuesto disponible.
        const cont = await requestContinuation(deps(), runId);
        if (cont.kind !== "queued") throw new Error("se esperaba un job nuevo");
        await queue.boss.cancel(QUEUES.instagramCollect, cont.jobId);
        expect(cont.job.baseAttempts).toBe(3);
        expect(await processCollectJob({ provider, store }, cont.job)).toMatchObject({
          stopReason: "target_reached",
          attempts: 5,
        });
        expect(provider.pageCalls()).toEqual([null, C25, C25, C50]);
        report("3. fallo y caída antes del cierre", {
          window,
          afterRedelivery,
          final: await stateOf(runId),
          calls: provider.calls.length,
        });
      } finally {
        g.release();
        held.release();
      }
    });

    it("5. vence mientras espera la reserva: cero reservas y cero llamadas", async () => {
      const { provider, runId, job } = await newRunJob();
      const single = new pg.Pool({ connectionString: URL_ENV as string, max: 1 });
      const pid = Number((await single.query("select pg_backend_pid() as pid")).rows[0].pid);
      const locker = await pool.connect();
      try {
        const lockerPid = Number(
          (await locker.query("select pg_backend_pid() as pid")).rows[0].pid,
        );
        await locker.query("begin");
        await locker.query("select id from instagram_runs where id = $1 for update", [runId]);
        const expiring = new AbortController();
        const pending = processCollectJob(
          { provider, store: new PgRunStore(single) },
          job,
          expiring.signal,
        );
        // Espera a que esa conexión concreta quede bloqueada por el locker al reservar.
        for (let i = 0; ; i++) {
          const r = await pool.query(
            "select wait_event_type, pg_blocking_pids(pid) as b from pg_stat_activity where pid = $1",
            [pid],
          );
          if (
            r.rows[0]?.wait_event_type === "Lock" &&
            (r.rows[0].b as number[]).includes(lockerPid)
          )
            break;
          if (i > 250) throw new Error("la entrega no quedó esperando la reserva");
          await new Promise((res) => setTimeout(res, 20));
        }
        expiring.abort(); // vence mientras espera
        await locker.query("rollback");
        expect(await within(pending, "entrega vencida")).toEqual({ kind: "aborted", reserved: [] });
        expect(await stateOf(runId)).toMatchObject({ attempt_count: 0, revision: 0, reserved: [] });
        expect(provider.calls).toHaveLength(0);
        // Una reentrega vigente sí trabaja.
        expect(await processCollectJob({ provider, store }, job)).toMatchObject({
          stopReason: "target_reached",
        });
        report("5. vencida esperando la reserva", { calls: 0, final: await stateOf(runId) });
      } finally {
        await locker.query("rollback").catch(() => {});
        locker.release();
        await single.end();
      }
    });

    it("6. entrega antigua sin baseAttempts: no repite automáticamente la llamada fallida", async () => {
      const { provider, runId, job } = await newRunJob();
      const g = gate();
      const held = provider.hold(C25);
      try {
        void processCollectJob(
          { provider, store, beforeFinish: (r) => (r === "provider_error" ? g.hook() : undefined) },
          job,
        );
        await within(held.called, "página 2");
        held.fail("HTTP 500 de la página 2");
        await within(g.reached, "entre el fallo y el cierre");
        // Carga de un job encolado antes de existir baseAttempts.
        const legacy = { runId, baseRevision: 0, baseEpoch: 0 } as unknown as CollectJob;
        expect(await processCollectJob({ provider, store }, legacy)).toMatchObject({
          stopReason: "provider_error",
          detail: "HTTP 500 de la página 2",
        });
        expect(provider.calls).toHaveLength(3);
        expect(await stateOf(runId)).toMatchObject({
          attempt_count: 3,
          stop: "provider_error",
          cursor: C25,
        });
        report("6. job antiguo sin baseAttempts", {
          ...(await stateOf(runId)),
          calls: provider.calls.length,
        });
      } finally {
        g.release();
        held.release();
      }
    });

    it("7. otra entrega ya cerró la solicitud: se conservan resultado y revisión", async () => {
      const { provider, runId, job } = await newRunJob();
      const g = gate();
      let reads = 0;
      const paused: RunStore = {
        create: (r) => store.create(r),
        getHead: async (id) => {
          reads++;
          if (reads === 2) await g.hook(); // tras la comprobación inicial, antes de collect
          return store.getHead(id);
        },
        extend: (...a) => store.extend(...a),
        reserveAttempt: (...a) => store.reserveAttempt(...a),
        commitResolve: (...a) => store.commitResolve(...a),
        commitPage: (...a) => store.commitPage(...a),
        failAttempt: (...a) => store.failAttempt(...a),
        recoverAttempt: (...a) => store.recoverAttempt(...a),
        finish: (...a) => store.finish(...a),
      };
      try {
        const d1 = processCollectJob({ provider, store: paused }, job);
        await within(g.reached, "d1 pausada");
        const out2 = await processCollectJob({ provider, store }, job);
        const closed = await store.snapshot(runId);
        g.release();
        // d1 decide target_reached con la revisión actual; el cierre no reescribe nada.
        expect(await within(d1, "d1")).toEqual(out2);
        expect(await store.snapshot(runId)).toEqual(closed);
        expect(provider.calls).toHaveLength(4);
        report("7. cierre ya publicado", {
          ...(await stateOf(runId)),
          calls: provider.calls.length,
        });
      } finally {
        g.release();
      }
    });

    it("4. job vencido: al entrar, entre páginas y con la petición en vuelo", async () => {
      // a) Vencido al entrar: cero reservas y cero llamadas.
      const a = await newRunJob();
      const expired = new AbortController();
      expired.abort();
      expect(
        await processCollectJob({ provider: a.provider, store }, a.job, expired.signal),
      ).toEqual({
        kind: "aborted",
        reserved: [],
      });
      expect(await stateOf(a.runId)).toMatchObject({ attempt_count: 0, revision: 0, epoch: 0 });
      expect(a.provider.calls).toHaveLength(0);

      // b) Vence entre la página 2 y la 3: se detiene antes de reservar la 3.
      const b = await newRunJob();
      const between = new AbortController();
      const outB = await processCollectJob(
        {
          provider: b.provider,
          store,
          beforeReserve: (op) => {
            if (op === `page:${JSON.stringify(C50)}`) between.abort();
          },
        },
        b.job,
        between.signal,
      );
      expect(outB).toEqual({ kind: "aborted", reserved: [] });
      const stopped = await stateOf(b.runId);
      expect(stopped).toMatchObject({ attempt_count: 3, cursor: C50, stop: null, reserved: [] });
      expect(b.provider.calls).toHaveLength(3);
      // La reentrega del mismo job continúa (la solicitud sigue vigente y sin resultado).
      expect(await processCollectJob({ provider: b.provider, store }, b.job)).toMatchObject({
        stopReason: "target_reached",
        attempts: 4,
      });
      expect(b.provider.calls).toHaveLength(4);

      // c) Vence con la petición de la página 2 en vuelo: la reserva queda abierta con su ID.
      const c = await newRunJob();
      const inFlight = new AbortController();
      const held = c.provider.hold(C25);
      try {
        const pending = processCollectJob({ provider: c.provider, store }, c.job, inFlight.signal);
        await within(held.called, "página 2 en vuelo");
        inFlight.abort();
        expect(await within(pending, "entrega vencida")).toEqual({
          kind: "aborted",
          reserved: [{ attemptId: 3, operation: `page:${JSON.stringify(C25)}` }],
        });
        held.release(); // respuesta tardía: no se escribe
        const open = await stateOf(c.runId);
        expect(open).toMatchObject({ attempt_count: 3, reserved: [3], stop: null, cursor: C25 });
        // Reentrega: in_progress con el mismo ID; recuperación explícita y continuación.
        const redelivered = await processCollectJob({ provider: c.provider, store }, c.job);
        expect(isInProgress(redelivered) && redelivered.reserved.map((x) => x.attemptId)).toEqual([
          3,
        ]);
        expect(await recoverInterrupted(store, c.runId, 3)).toBe(1);
        const cont = await requestContinuation(deps(), c.runId);
        if (cont.kind !== "queued") throw new Error("se esperaba un job nuevo");
        await queue.boss.cancel(QUEUES.instagramCollect, cont.jobId);
        expect(await processCollectJob({ provider: c.provider, store }, cont.job)).toMatchObject({
          stopReason: "target_reached",
          attempts: 5,
        });
        report("4. vencimiento", {
          entrada: { attempts: 0, calls: a.provider.calls.length },
          entrePaginas: { ...stopped, callsAlDetenerse: 3 },
          enVuelo: { ...open, final: await stateOf(c.runId), calls: c.provider.calls.length },
        });
      } finally {
        held.release();
      }
    });
  });
});
