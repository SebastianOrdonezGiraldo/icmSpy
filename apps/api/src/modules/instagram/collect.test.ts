/**
 * Núcleo de recolección con proveedor falso y almacén en memoria (sin red).
 * Los casos A y B reproducen la forma de las pruebas reales con datos inventados.
 */
import { describe, expect, it } from "vitest";
import {
  type CollectDeps,
  collect,
  contactEligibleFollowers,
  createRun,
  type DeliveryRequest,
  extendRun,
  fetchPage,
  InvalidCursor,
  isInProgress,
  LeaseLost,
  recoverInterrupted,
  SimulatedCrash,
  selectedFollowers,
} from "./collect";
import {
  cursorTarget,
  FIRST_CURSOR,
  INVALID_CURSORS,
  invalidCursorProvider,
  VALID_CURSOR_CHAIN,
  validChainProvider,
} from "./cursor-scenarios";
import { estimateCalls } from "./estimate";
import { FakeInstagramProvider, syntheticFollowers } from "./fake-provider";
import { MemoryRunStore, type RunStore } from "./store";
import type { Cursor, FollowersPage, StopReason, TargetAccount } from "./types";

// Cursores opacos deliberadamente "raros": el núcleo no debe interpretarlos.
const C25 = "Zm9v/==?p=25&x= 1";
const C50 = "  50  ";
const C75 = '{"next":"75"}';

const verifiedTarget: TargetAccount = {
  pk: "100000001",
  username: "cuenta_verificada_demo",
  followerCount: 25_765,
  isPrivate: false,
  isVerified: true,
};
const openTarget: TargetAccount = {
  pk: "100000002",
  username: "cuenta_abierta_demo",
  followerCount: 8_852,
  isPrivate: false,
  isVerified: false,
};

const page = (
  users: FollowersPage["users"],
  nextCursor: Cursor | null,
  limited = false,
): FollowersPage => ({
  users,
  nextCursor,
  limited,
});

/** Caso A: 49 seguidores, bandera de límite y sin cursor. */
function caseA() {
  return new FakeInstagramProvider(verifiedTarget, [
    { cursor: null, page: page(syntheticFollowers(1, 49), null, true) },
  ]);
}

/** Caso B: tres páginas de 25 con cursores opacos; sigue habiendo continuación. */
function caseB(failOn?: Set<string>) {
  return new FakeInstagramProvider(
    openTarget,
    [
      { cursor: null, page: page(syntheticFollowers(1, 25), C25) },
      { cursor: C25, page: page(syntheticFollowers(26, 25), C50) },
      { cursor: C50, page: page(syntheticFollowers(51, 25), C75) },
      { cursor: C75, page: page(syntheticFollowers(76, 25), "fin-no-usado") },
    ],
    failOn,
  );
}

async function setup(
  provider: FakeInstagramProvider,
  username: string,
  requested: number,
  budgetMaxCalls: number,
) {
  const store = new MemoryRunStore();
  await createRun(store, { id: "run-1", username, requested, budgetMaxCalls });
  return { store, deps: { provider, store }, runId: "run-1" };
}

describe("casos reales reproducidos con datos sintéticos", () => {
  it("A: 49 de 25.765, lista limitada sin cursor → source_limited con 2 llamadas", async () => {
    const provider = caseA();
    const { deps, runId, store } = await setup(provider, verifiedTarget.username, 100, 10);
    const out = await collect(deps, runId);
    expect(out).toMatchObject({
      stopReason: "source_limited",
      targetReached: false,
      continuationAvailable: false,
      uniqueReceived: 49,
      declaredFollowers: 25_765,
      attempts: 2,
    });
    expect(provider.calls).toHaveLength(2);
    expect(store.snapshot(runId).cursor).toBeNull();
  });

  it("B: 75 de 8.852 en 3 páginas → target_reached, 4 llamadas y cursor guardado", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const out = await collect(deps, runId);
    expect(out).toMatchObject({
      stopReason: "target_reached",
      targetReached: true,
      continuationAvailable: true,
      uniqueReceived: 75,
      selected: 75,
      declaredFollowers: 8_852,
      attempts: 4,
    });
    expect(store.snapshot(runId).cursor).toBe(C75); // opaco, intacto
    expect(provider.pageCalls()).toEqual([null, C25, C50]); // reenviados tal cual
  });
});

describe("objetivos, cursores y motivos de parada", () => {
  it("rechaza objetivos y presupuestos que no son enteros positivos", async () => {
    const store = new MemoryRunStore();
    for (const requested of [0, -5, 2.5, Number.NaN]) {
      await expect(
        createRun(store, { id: `r${requested}`, username: "x", requested, budgetMaxCalls: 5 }),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      createRun(store, { id: "rb", username: "x", requested: 60, budgetMaxCalls: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("se detiene ante la bandera de límite aunque haya cursor", async () => {
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page(syntheticFollowers(1, 25), "hay-mas", true) },
    ]);
    const { deps, runId } = await setup(provider, openTarget.username, 75, 10);
    const out = await collect(deps, runId);
    expect(out).toMatchObject({
      stopReason: "source_limited",
      continuationAvailable: false,
      attempts: 2,
    });
  });

  it("lista agotada antes del objetivo → list_exhausted", async () => {
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page(syntheticFollowers(1, 25), "a") },
      { cursor: "a", page: page(syntheticFollowers(26, 10), null) },
    ]);
    const { deps, runId } = await setup(provider, openTarget.username, 75, 10);
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "list_exhausted",
      targetReached: false,
      continuationAvailable: false,
      uniqueReceived: 35,
    });
  });

  it("objetivo justo en la última página: objetivo cumplido y sin continuación", async () => {
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page(syntheticFollowers(1, 25), "a") },
      { cursor: "a", page: page(syntheticFollowers(26, 25), "b") },
      { cursor: "b", page: page(syntheticFollowers(51, 25), null) },
    ]);
    const { deps, runId } = await setup(provider, openTarget.username, 75, 10);
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "target_reached",
      targetReached: true,
      continuationAvailable: false,
      listState: "exhausted",
    });
  });

  it("cuenta privada → target_private sin pedir páginas", async () => {
    const provider = new FakeInstagramProvider({ ...openTarget, isPrivate: true }, []);
    const { deps, runId } = await setup(provider, openTarget.username, 75, 10);
    expect(await collect(deps, runId)).toMatchObject({ stopReason: "target_private", attempts: 1 });
    expect(provider.pageCalls()).toEqual([]);
  });

  it("cursor repetido (la fuente devuelve el mismo cursor) → cursor_repeated", async () => {
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page(syntheticFollowers(1, 25), "a") },
      { cursor: "a", page: page(syntheticFollowers(26, 25), "a") },
    ]);
    const { deps, runId } = await setup(provider, openTarget.username, 200, 20);
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "cursor_repeated",
      continuationAvailable: false,
      attempts: 3,
    });
  });

  it("ciclo A → B → A → cursor_cycle sin seguir llamando", async () => {
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page(syntheticFollowers(1, 25), "A") },
      { cursor: "A", page: page(syntheticFollowers(26, 25), "B") },
      { cursor: "B", page: page(syntheticFollowers(51, 25), "A") },
    ]);
    const { deps, runId } = await setup(provider, openTarget.username, 500, 20);
    expect(await collect(deps, runId)).toMatchObject({ stopReason: "cursor_cycle", attempts: 4 });
    expect(provider.pageCalls()).toEqual([null, "A", "B"]);
  });

  it("error de la fuente → provider_error; el intento fallido ocupa presupuesto", async () => {
    const { deps, runId, store } = await setup(
      caseB(new Set([JSON.stringify(C25)])),
      openTarget.username,
      75,
      10,
    );
    const out = await collect(deps, runId);
    expect(out).toMatchObject({ stopReason: "provider_error", uniqueReceived: 25, attempts: 3 });
    expect(store.snapshot(runId).attempts.map((a) => a.status)).toEqual([
      "succeeded",
      "succeeded",
      "failed",
    ]);
  });
});

describe("presupuesto", () => {
  it("estimación por tamaño típico de página (25)", () => {
    expect(estimateCalls({ requested: 75 })).toMatchObject({
      resolveCalls: 1,
      pageCalls: 3,
      total: 4,
    });
    expect(estimateCalls({ requested: 60 })).toMatchObject({ pageCalls: 3, total: 4 });
    expect(estimateCalls({ requested: 75, alreadyUnique: 50, resolved: true })).toMatchObject({
      total: 1,
    });
    expect(estimateCalls({ requested: 75 }).basis).toMatch(/estimación/);
  });

  it("con 3 llamadas el caso B se detiene tras la 2.ª página; al ampliar a 4 pide solo la 3.ª", async () => {
    const provider = caseB();
    const { deps, runId } = await setup(provider, openTarget.username, 75, 3);
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "budget_exhausted",
      uniqueReceived: 50,
      attempts: 3,
      continuationAvailable: true,
    });
    expect(provider.calls).toHaveLength(3);

    await extendRun(deps.store, runId, { budgetMaxCalls: 4 });
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "target_reached",
      uniqueReceived: 75,
      attempts: 4,
    });
    // La resolución se contó una sola vez y solo se pidió la tercera página.
    expect(provider.calls.slice(3)).toEqual([{ kind: "page", cursor: C50 }]);
    expect(provider.calls.filter((c) => c.kind === "resolve")).toHaveLength(1);
  });

  it("con presupuesto 1 solo se resuelve la cuenta", async () => {
    const provider = caseB();
    const { deps, runId } = await setup(provider, openTarget.username, 75, 1);
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "budget_exhausted",
      uniqueReceived: 0,
      attempts: 1,
    });
  });
});

describe("operación lógica frente a intentos", () => {
  it("caída tras recibir la página 2: cobro incierto, ocupa presupuesto y no avanza el cursor", async () => {
    const provider = caseB();
    const store = new MemoryRunStore();
    await createRun(store, {
      id: "run-1",
      username: openTarget.username,
      requested: 75,
      budgetMaxCalls: 4,
    });
    const crashing = {
      provider,
      store,
      beforeCommit: (op: string) => {
        if (op === `page:${JSON.stringify(C25)}`) throw new SimulatedCrash("caída simulada");
      },
    };
    await expect(collect(crashing, "run-1")).rejects.toBeInstanceOf(SimulatedCrash);
    let run = store.snapshot("run-1");
    expect(run.cursor).toBe(C25); // no avanzó
    expect(run.followers).toHaveLength(25);
    expect(run.attempts.at(-1)?.status).toBe("reserved");

    // Una reserva sin reconciliar se trata como trabajo activo: la entrega se retira sin
    // llamar a la fuente ni consumir presupuesto; la recuperación es explícita.
    expect(await collect({ provider, store }, "run-1")).toEqual({
      kind: "in_progress",
      reserved: [{ attemptId: 3, operation: `page:${JSON.stringify(C25)}` }],
    });
    expect(provider.calls).toHaveLength(3);
    expect(store.snapshot("run-1").attempts).toHaveLength(3);
    expect(await recoverInterrupted(store, "run-1", 3)).toBe(1);

    // El reintento de la misma operación necesita reserva propia; con 4 ya no llega a la página 3.
    const out = await collect({ provider, store }, "run-1");
    run = store.snapshot("run-1");
    expect(out).toMatchObject({ stopReason: "budget_exhausted", uniqueReceived: 50, attempts: 4 });
    expect(run.attempts.map((a) => [a.operation, a.status])).toEqual([
      ["resolve", "succeeded"],
      [`page:${JSON.stringify(null)}`, "succeeded"],
      [`page:${JSON.stringify(C25)}`, "uncertain"],
      [`page:${JSON.stringify(C25)}`, "succeeded"],
    ]);
    expect(provider.calls).toHaveLength(4);
  });

  it("entrega duplicada de una página confirmada: sin llamada nueva y sin cambiar contadores", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    await collect(deps, runId);
    const before = store.snapshot(runId);
    const callsBefore = provider.calls.length;

    expect(await fetchPage(deps, runId, C25)).toBe("already_confirmed");
    expect(await fetchPage(deps, runId, null)).toBe("already_confirmed");

    const after = store.snapshot(runId);
    expect(provider.calls).toHaveLength(callsBefore);
    expect(after.followers).toEqual(before.followers);
    expect(after.pages).toEqual(before.pages);
    expect(after.attempts).toEqual(before.attempts);
  });
});

describe("deduplicación y selección", () => {
  it("deduplica por ID dentro de la página y entre páginas, en orden de primera aparición", async () => {
    const [u1, u2, u3, u4] = syntheticFollowers(1, 4);
    if (!u1 || !u2 || !u3 || !u4) throw new Error("fixture");
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page([u1, u2, u1, u3], "a") },
      { cursor: "a", page: page([u3, u2, u4], null) },
    ]);
    const { deps, runId, store } = await setup(provider, openTarget.username, 10, 10);
    await collect(deps, runId);
    const run = store.snapshot(runId);
    expect(run.followers.map((f) => f.pk)).toEqual([u1.pk, u2.pk, u3.pk, u4.pk]);
    expect(run.followers.map((f) => f.order)).toEqual([1, 2, 3, 4]);
    expect(run.pages.map((p) => [p.received, p.newUnique, p.duplicates])).toEqual([
      [4, 3, 1],
      [3, 1, 2],
    ]);
  });

  it("objetivo 60: recibe 75, selecciona 60; al ampliar a 70 usa el excedente sin llamar", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 60, 10);
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "target_reached",
      uniqueReceived: 75,
      selected: 60,
      attempts: 4,
      continuationAvailable: true,
    });
    const callsBefore = provider.calls.length;

    await extendRun(store, runId, { requested: 70 });
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "target_reached",
      uniqueReceived: 75,
      selected: 70,
      attempts: 4,
    });
    expect(provider.calls).toHaveLength(callsBefore);

    // Los seleccionados conservan si son públicos, para la futura etapa de contactos.
    const selected = selectedFollowers(store.snapshot(runId));
    expect(selected).toHaveLength(70);
    expect(selected.map((f) => f.order)).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
    const expectedPublic = syntheticFollowers(1, 70).filter((u) => !u.isPrivate).length;
    expect(selected.filter((f) => !f.isPrivate)).toHaveLength(expectedPublic);
  });

  it("no permite reducir objetivo ni presupuesto", async () => {
    const store = new MemoryRunStore();
    await createRun(store, { id: "r", username: "x", requested: 75, budgetMaxCalls: 4 });
    await expect(extendRun(store, "r", { requested: 60 })).rejects.toThrow(RangeError);
    await expect(extendRun(store, "r", { budgetMaxCalls: 3 })).rejects.toThrow(RangeError);
  });
});

describe("regresiones de la revisión", () => {
  const statuses = (store: MemoryRunStore, runId: string) =>
    store.snapshot(runId).attempts.map((a) => a.status);

  it("1. dos entregas simultáneas de la misma página: una sola llamada y una sola reserva", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 2);
    expect(await collect(deps, runId)).toMatchObject({ stopReason: "budget_exhausted" });
    await extendRun(store, runId, { budgetMaxCalls: 10 });

    const held = provider.hold(C25);
    const first = fetchPage(deps, runId, C25);
    const second = fetchPage(deps, runId, C25);
    await held.called;
    held.release();
    expect(await first).toBe("committed");
    expect(await second).toEqual({
      kind: "in_progress",
      reserved: [{ attemptId: 3, operation: `page:${JSON.stringify(C25)}` }],
    });
    expect(await fetchPage(deps, runId, C25)).toBe("already_confirmed"); // sigue idempotente

    const run = store.snapshot(runId);
    expect(provider.pageCalls().filter((c) => c === C25)).toHaveLength(1);
    expect(run.attempts.filter((a) => a.operation === `page:${JSON.stringify(C25)}`)).toHaveLength(
      1,
    );
    expect(run.attempts).toHaveLength(3); // resolve + página 1 + página 2
    expect(run.pages.filter((p) => p.requestCursor === C25)).toHaveLength(1);
    expect(run.followers).toHaveLength(50);
  });

  it("2a. datos tardíos tras reconciliar: no escriben y el intento sigue incierto", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const held = provider.hold(C25);
    const stale = collect(deps, runId);
    await held.called;
    expect(await recoverInterrupted(store, runId, 3)).toBe(1);
    const snapshot = store.snapshot(runId);

    held.release(); // los datos llegan después de la reconciliación
    await expect(stale).rejects.toBeInstanceOf(LeaseLost);
    expect(store.snapshot(runId)).toEqual(snapshot);
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.outcome).toBeNull();
    expect(statuses(store, runId)).toEqual(["succeeded", "succeeded", "uncertain"]);

    // Una entrega nueva reintenta con reserva propia; el incierto sigue ocupando presupuesto.
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "target_reached",
      uniqueReceived: 75,
      attempts: 5,
    });
    expect(provider.pageCalls()).toEqual([null, C25, C25, C50]);
  });

  it("2b. error tardío tras reconciliar: no marca failed ni cierra la ejecución", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const held = provider.hold(C25);
    const stale = collect(deps, runId);
    await held.called;
    expect(await recoverInterrupted(store, runId, 3)).toBe(1);
    const snapshot = store.snapshot(runId);

    held.fail("HTTP 502 tardío");
    await expect(stale).rejects.toBeInstanceOf(LeaseLost);
    const run = store.snapshot(runId);
    expect(run).toEqual(snapshot);
    expect(run.outcome).toBeNull(); // no quedó provider_error
    expect(run.attempts.at(-1)).toMatchObject({ status: "uncertain" });
    expect(run.attempts.at(-1)?.error).toBeUndefined();
  });

  it("2c. orden inverso: los datos llegan antes de reconciliar y no queda nada incierto", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const held = provider.hold(C25);
    const worker = collect(deps, runId);
    await held.called;
    held.release();
    expect(await worker).toMatchObject({ stopReason: "target_reached", attempts: 4 });
    expect(await recoverInterrupted(store, runId, 3)).toBe(0);
    expect(statuses(store, runId)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  });

  it("2d. aviso repetido del intento 2 mientras su reemplazo está en vuelo: devuelve 0", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);

    // El intento 2 (página 1) queda interrumpido y se reconcilia.
    const held1 = provider.hold(null);
    const stale = collect(deps, runId);
    await held1.called;
    expect(await recoverInterrupted(store, runId, 2)).toBe(1);
    held1.release();
    await expect(stale).rejects.toBeInstanceOf(LeaseLost);

    // El reemplazo (intento 3) está en vuelo cuando llega el aviso repetido del intento 2.
    const held2 = provider.hold(null);
    const replacement = collect(deps, runId);
    await held2.called;
    const inFlight = store.snapshot(runId);
    expect(inFlight.attempts.at(-1)).toMatchObject({ id: 3, status: "reserved" });
    expect(await recoverInterrupted(store, runId, 2)).toBe(0); // ya reconciliado
    expect(await recoverInterrupted(store, runId, 99)).toBe(0); // inexistente
    expect(store.snapshot(runId)).toEqual(inFlight); // estado íntegro, epoch incluido

    held2.release();
    expect(await replacement).toMatchObject({ stopReason: "target_reached", attempts: 5 });
    expect(statuses(store, runId)).toEqual([
      "succeeded",
      "uncertain",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(provider.calls).toEqual([
      { kind: "resolve" },
      { kind: "page", cursor: null },
      { kind: "page", cursor: null },
      { kind: "page", cursor: C25 },
      { kind: "page", cursor: C50 },
    ]);
  });

  it("2e. aviso tardío de la página 1 ya confirmada mientras se consulta la 2: devuelve 0", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const held = provider.hold(C25);
    const worker = collect(deps, runId);
    await held.called; // intento 2 confirmado, intento 3 en vuelo, mismo epoch
    const inFlight = store.snapshot(runId);
    expect(inFlight.attempts.map((a) => [a.id, a.status])).toEqual([
      [1, "succeeded"],
      [2, "succeeded"],
      [3, "reserved"],
    ]);

    expect(await recoverInterrupted(store, runId, 2)).toBe(0);
    expect(store.snapshot(runId)).toEqual(inFlight);

    held.release();
    expect(await worker).toMatchObject({ stopReason: "target_reached", attempts: 4 });
    expect(statuses(store, runId)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(provider.pageCalls()).toEqual([null, C25, C50]);
    expect(provider.calls).toHaveLength(4);
  });

  it("3a. entrega posterior a target_private: no toca proveedor, intentos, páginas ni resultado", async () => {
    const provider = new FakeInstagramProvider({ ...openTarget, isPrivate: true }, []);
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    await collect(deps, runId);
    const before = store.snapshot(runId);
    expect(await fetchPage(deps, runId, null)).toEqual({ skipped: "target_private" });
    expect(provider.calls).toHaveLength(1);
    expect(store.snapshot(runId)).toEqual(before);
  });

  it("3b. entrega posterior a source_limited: no toca proveedor, intentos, páginas ni resultado", async () => {
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page(syntheticFollowers(1, 25), "hay-mas", true) },
    ]);
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    expect(await collect(deps, runId)).toMatchObject({ stopReason: "source_limited" });
    const before = store.snapshot(runId);
    expect(await fetchPage(deps, runId, "hay-mas")).toEqual({ skipped: "list_closed" });
    expect(await fetchPage(deps, runId, null)).toBe("already_confirmed");
    expect(provider.calls).toHaveLength(2);
    expect(store.snapshot(runId)).toEqual(before);
  });

  it("3c. cursor inesperado u objetivo ya cubierto: no reserva ni llama", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 3);
    await collect(deps, runId); // se detiene con cursor C50
    await extendRun(store, runId, { budgetMaxCalls: 10 });
    const before = store.snapshot(runId);
    expect(await fetchPage(deps, runId, C75)).toEqual({ skipped: "unexpected_cursor" });
    expect(provider.calls).toHaveLength(3);
    expect(store.snapshot(runId)).toEqual(before);

    const other = caseB();
    const small = await setup(other, openTarget.username, 25, 10);
    await collect(small.deps, small.runId); // objetivo cubierto con la página 1
    const beforeSmall = small.store.snapshot(small.runId);
    expect(await fetchPage(small.deps, small.runId, C25)).toEqual({ skipped: "target_reached" });
    expect(other.calls).toHaveLength(2);
    expect(small.store.snapshot(small.runId)).toEqual(beforeSmall);
  });

  it("4. ID repetido con distinta privacidad: conserva posición, cuenta duplicado y no es elegible", async () => {
    const [u1, u2, u3] = syntheticFollowers(1, 3); // u1 y u2 públicos, u3 privado
    if (!u1 || !u2 || !u3) throw new Error("fixture");
    const provider = new FakeInstagramProvider(openTarget, [
      { cursor: null, page: page([u1, u3], "a") },
      {
        cursor: "a",
        page: page([{ ...u1, isPrivate: true }, { ...u3, isPrivate: false }, u2], null),
      },
    ]);
    const { deps, runId, store } = await setup(provider, openTarget.username, 10, 10);
    await collect(deps, runId);
    const run = store.snapshot(runId);
    expect(run.followers.map((f) => [f.pk, f.order, f.isPrivate, f.privacyConflict])).toEqual([
      [u1.pk, 1, true, true], // público y luego privado → privado
      [u3.pk, 2, true, true], // privado y luego público → sigue privado
      [u2.pk, 3, false, false],
    ]);
    expect(run.pages.map((p) => [p.received, p.newUnique, p.duplicates])).toEqual([
      [2, 2, 0],
      [3, 1, 2],
    ]);
    expect(contactEligibleFollowers(run).map((f) => f.pk)).toEqual([u2.pk]);
  });
});

/**
 * Almacén de prueba: las primeras `parties` lecturas esperan juntas en una barrera (promesas,
 * sin temporizadores), de modo que todos los trabajadores observan el mismo estado antes de
 * que ninguno reserve. Las operaciones atómicas pasan directas al almacén en memoria.
 */
class BarrierStore implements RunStore {
  private waiting: Array<() => void> = [];
  private armed = true;

  constructor(
    private readonly inner: MemoryRunStore,
    private readonly parties: number,
  ) {}

  async getHead(runId: string) {
    const head = await this.inner.getHead(runId);
    if (this.armed) {
      await new Promise<void>((resume) => {
        this.waiting.push(resume);
        if (this.waiting.length === this.parties) {
          this.armed = false;
          for (const w of this.waiting) w();
        }
      });
    }
    return head;
  }

  create: RunStore["create"] = (run) => this.inner.create(run);
  extend: RunStore["extend"] = (...a) => this.inner.extend(...a);
  reserveAttempt: RunStore["reserveAttempt"] = (...a) => this.inner.reserveAttempt(...a);
  commitResolve: RunStore["commitResolve"] = (...a) => this.inner.commitResolve(...a);
  commitPage: RunStore["commitPage"] = (...a) => this.inner.commitPage(...a);
  failAttempt: RunStore["failAttempt"] = (...a) => this.inner.failAttempt(...a);
  recoverAttempt: RunStore["recoverAttempt"] = (...a) => this.inner.recoverAttempt(...a);
  finish: RunStore["finish"] = (...a) => this.inner.finish(...a);
}

describe("almacén asíncrono", () => {
  it("dos trabajadores ven la cuenta sin resolver: una llamada y una sola reserva de resolución", async () => {
    const provider = caseB();
    const inner = new MemoryRunStore();
    await createRun(inner, {
      id: "run-1",
      username: openTarget.username,
      requested: 75,
      budgetMaxCalls: 10,
    });
    const store = new BarrierStore(inner, 2);
    const held = provider.holdResolve();

    const workers = [collect({ provider, store }, "run-1"), collect({ provider, store }, "run-1")];
    await held.called; // un trabajador reservó y está esperando a la fuente

    const inFlight = inner.snapshot("run-1");
    expect(inFlight.target).toBeNull();
    expect(inFlight.attempts).toEqual([
      { id: 1, operation: "resolve", kind: "resolve", status: "reserved" },
    ]);

    held.release();
    const results = await Promise.all(workers);
    const yielded = results.filter(isInProgress);
    const finished = results.filter((r) => !isInProgress(r));
    expect(yielded).toEqual([
      { kind: "in_progress", reserved: [{ attemptId: 1, operation: "resolve" }] },
    ]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ stopReason: "target_reached", attempts: 4 });

    const run = inner.snapshot("run-1");
    expect(run.outcome).toEqual(finished[0]); // resultado persistido
    expect(provider.calls.filter((c) => c.kind === "resolve")).toHaveLength(1);
    expect(run.attempts.filter((x) => x.kind === "resolve")).toHaveLength(1);
    expect(provider.pageCalls()).toEqual([null, C25, C50]);
  });
});

/** Promesa controlable a mano (sin temporizadores). */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Dependencias cuyo cierre se detiene tras decidir `reason` hasta que la prueba lo libere. */
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

describe("cierre condicionado y trabajo en curso", () => {
  it("un cierre por error que llega después del éxito de un reintento no lo sobrescribe", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const a = pausedAtFinish(deps, "provider_error");
    const held = provider.hold(C25);

    const workerA = collect(a.deps, runId);
    await held.called;
    held.fail("HTTP 500 transitorio");
    await a.decided; // A decidió provider_error y aún no lo guardó

    const outB = await collect(deps, runId); // B reintenta la página 2 y termina
    expect(outB).toMatchObject({ stopReason: "target_reached", attempts: 5 });
    const afterB = store.snapshot(runId);

    a.resume();
    const outA = await workerA;
    expect(outA).toEqual(outB); // A devuelve el resultado vigente de B
    expect(store.snapshot(runId)).toEqual(afterB); // revisión final intacta
    expect(store.snapshot(runId).revision).toBe(afterB.revision);

    const run = store.snapshot(runId);
    expect(run.outcome).toMatchObject({ stopReason: "target_reached", uniqueReceived: 75 });
    expect(run.outcome?.detail).toBeUndefined();
    expect(run.attempts.map((x) => x.status)).toEqual([
      "succeeded",
      "succeeded",
      "failed",
      "succeeded",
      "succeeded",
    ]);
    expect(provider.pageCalls()).toEqual([null, C25, C25, C50]);
    expect(provider.calls).toHaveLength(5);
  });

  it("un cierre por presupuesto que llega después de ampliar y completar no lo sobrescribe", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 3);
    const a = pausedAtFinish(deps, "budget_exhausted");

    const workerA = collect(a.deps, runId);
    await a.decided; // A vio el presupuesto agotado tras la página 2

    await extendRun(store, runId, { budgetMaxCalls: 4 });
    const outB = await collect(deps, runId);
    expect(outB).toMatchObject({ stopReason: "target_reached", attempts: 4 });
    const afterB = store.snapshot(runId);

    a.resume();
    expect(await workerA).toEqual(outB);
    expect(store.snapshot(runId)).toEqual(afterB);

    const run = store.snapshot(runId);
    expect(run.outcome).toMatchObject({ stopReason: "target_reached", uniqueReceived: 75 });
    expect(run.attempts).toHaveLength(4);
    expect(provider.pageCalls()).toEqual([null, C25, C50]);
    expect(provider.calls).toHaveLength(4);
  });

  /**
   * A queda en pausa tras decidir provider_error; B reintenta la página 2, falla y guarda su
   * propio provider_error. Al liberar A, debe devolver el resultado de B sin tocar nada.
   */
  async function errorAfterError(budgetMaxCalls: number) {
    const provider = caseB(new Set([JSON.stringify(C25)])); // B falla con "HTTP 500 simulado"
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, budgetMaxCalls);
    const a = pausedAtFinish(deps, "provider_error");
    const held = provider.hold(C25);

    const workerA = collect(a.deps, runId);
    await held.called;
    held.fail("error de A");
    await a.decided;

    const outB = await collect(deps, runId);
    expect(outB).toMatchObject({
      stopReason: "provider_error",
      detail: "HTTP 500 simulado",
      attempts: 4,
    });
    const afterB = store.snapshot(runId);
    expect(afterB.outcome).toEqual(outB);

    a.resume();
    const outA = await workerA;
    expect(outA).toEqual(outB); // resultado de B, con su detalle
    expect(store.snapshot(runId)).toEqual(afterB); // estado idéntico, revisión incluida
    expect(provider.calls).toHaveLength(4); // resolución + página 1 + dos intentos de la 2
    expect(afterB.attempts.map((x) => [x.status, x.error ?? null])).toEqual([
      ["succeeded", null],
      ["succeeded", null],
      ["failed", "error de A"],
      ["failed", "HTTP 500 simulado"],
    ]);
    return { provider, deps, runId, store };
  }

  it("error tras error con el presupuesto agotado: A devuelve el resultado de B sin tocar nada", async () => {
    const { store, runId } = await errorAfterError(4);
    expect(store.snapshot(runId).attempts).toHaveLength(4);
  });

  it("error tras error con una llamada disponible: A no la gasta; un reintento explícito sí", async () => {
    const { provider, deps, runId } = await errorAfterError(5);

    // Solicitar explícitamente otro intento sigue siendo posible.
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "provider_error",
      attempts: 5,
    });
    expect(provider.pageCalls()).toEqual([null, C25, C25, C25]);
  });

  it("error previo guardado; A falla y B consigue la página: A devuelve superseded", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 50, 10);

    // Un error previo queda guardado como resultado.
    const held0 = provider.hold(C25);
    const worker0 = collect(deps, runId);
    await held0.called;
    held0.fail("error inicial");
    expect(await worker0).toMatchObject({ stopReason: "provider_error", detail: "error inicial" });

    // A reintenta (su reserva invalida el resultado anterior), falla y espera antes de cerrar.
    const a = pausedAtFinish(deps, "provider_error");
    const held1 = provider.hold(C25);
    const workerA = collect(a.deps, runId);
    await held1.called;
    expect(store.snapshot(runId).outcome).toBeNull();
    held1.fail("error de A");
    await a.decided;

    // B reintenta, consigue la página y espera antes de publicar su resultado.
    const b = pausedAtFinish(deps, "target_reached");
    const workerB = collect(b.deps, runId);
    await b.decided;

    const beforeA = store.snapshot(runId);
    const callsBeforeA = provider.calls.length;
    expect(beforeA.outcome).toBeNull(); // sin resultado vigente
    expect(beforeA.attempts.some((x) => x.status === "reserved")).toBe(false); // sin reserva activa

    a.resume();
    expect(await workerA).toEqual({ kind: "superseded" });
    expect(store.snapshot(runId)).toEqual(beforeA); // revisión incluida
    expect(provider.calls).toHaveLength(callsBeforeA);

    b.resume();
    const outB = await workerB;
    expect(outB).toMatchObject({
      stopReason: "target_reached",
      targetReached: true,
      uniqueReceived: 50,
      selected: 50,
      attempts: 5,
      continuationAvailable: true,
    });
    expect(outB).not.toHaveProperty("detail");
    const run = store.snapshot(runId);
    expect(run.outcome).toEqual(outB);
    expect(run.attempts.map((x) => [x.status, x.error ?? null])).toEqual([
      ["succeeded", null],
      ["succeeded", null],
      ["failed", "error inicial"],
      ["failed", "error de A"],
      ["succeeded", null],
    ]);
    expect(run.pages).toHaveLength(2);
    expect(provider.pageCalls()).toEqual([null, C25, C25, C25]);
  });

  it("ampliación sin otro trabajador: el cierre atrasado devuelve superseded; solo collect reanuda", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 3);
    const a = pausedAtFinish(deps, "budget_exhausted");
    const workerA = collect(a.deps, runId);
    await a.decided;

    await extendRun(store, runId, { budgetMaxCalls: 4 });
    const afterExtend = store.snapshot(runId);

    a.resume();
    expect(await workerA).toEqual({ kind: "superseded" });
    expect(store.snapshot(runId)).toEqual(afterExtend);
    expect(provider.calls).toHaveLength(3); // no reanudó por su cuenta

    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "target_reached",
      uniqueReceived: 75,
      attempts: 4,
    });
    expect(provider.pageCalls()).toEqual([null, C25, C50]);
  });

  it("una reserva denegada o duplicada deja intacto el resultado vigente", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 3);
    expect(await collect(deps, runId)).toMatchObject({ stopReason: "budget_exhausted" });
    const before = store.snapshot(runId);

    expect(await fetchPage(deps, runId, C50)).toBe("budget"); // denegada
    expect(await fetchPage(deps, runId, C25)).toBe("already_confirmed"); // duplicada
    expect(store.snapshot(runId)).toEqual(before);
    expect(provider.calls).toHaveLength(3);
  });

  it("segunda entrega después de reservar la resolución: se retira sin reconciliar ni consumir", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const held = provider.holdResolve();
    const workerA = collect(deps, runId);
    await held.called;
    const before = store.snapshot(runId);

    expect(await collect(deps, runId)).toEqual({
      kind: "in_progress",
      reserved: [{ attemptId: 1, operation: "resolve" }],
    });
    expect(store.snapshot(runId)).toEqual(before); // sin reconciliar ni reservar
    expect(provider.calls).toHaveLength(1);

    held.release();
    const outA = await workerA;
    expect(outA).toMatchObject({ stopReason: "target_reached", attempts: 4 });
    const run = store.snapshot(runId);
    expect(run.outcome).toEqual(outA);
    expect(run.attempts.filter((x) => x.kind === "resolve")).toHaveLength(1);
    expect(provider.calls.filter((c) => c.kind === "resolve")).toHaveLength(1);
    expect(provider.calls).toHaveLength(4);
  });

  it("segunda entrega después de reservar una página: se retira sin reconciliar ni consumir", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const held = provider.hold(C25);
    const workerA = collect(deps, runId);
    await held.called;
    const before = store.snapshot(runId);
    const signal = {
      kind: "in_progress",
      reserved: [{ attemptId: 3, operation: `page:${JSON.stringify(C25)}` }],
    };

    expect(await collect(deps, runId)).toEqual(signal);
    expect(await fetchPage(deps, runId, C25)).toEqual(signal);
    expect(store.snapshot(runId)).toEqual(before);
    expect(provider.calls).toHaveLength(3);

    held.release();
    const outA = await workerA;
    expect(outA).toMatchObject({ stopReason: "target_reached", attempts: 4 });
    const run = store.snapshot(runId);
    expect(run.outcome).toEqual(outA);
    expect(run.attempts.map((x) => x.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(provider.pageCalls()).toEqual([null, C25, C50]);
  });
});

describe("cursores de continuación", () => {
  it('conserva exactamente U+FFFD, un emoji, la cadena vacía, el texto "null" y null', async () => {
    const provider = validChainProvider();
    const { deps, runId, store } = await setup(provider, cursorTarget.username, 100, 10);
    expect(await collect(deps, runId)).toMatchObject({
      stopReason: "list_exhausted",
      uniqueReceived: 50,
    });
    expect(provider.pageCalls()).toEqual(VALID_CURSOR_CHAIN); // reenviados tal cual
    const run = store.snapshot(runId);
    expect(run.pages.map((p) => [p.requestCursor, p.nextCursor])).toEqual(
      VALID_CURSOR_CHAIN.map((c, i) => [c, VALID_CURSOR_CHAIN[i + 1] ?? null]),
    );
    expect(new Set(run.attempts.map((a) => a.operation)).size).toBe(6); // ninguna se confunde
  });

  for (const [label, bad, reason] of INVALID_CURSORS) {
    it(`cursor con ${label}: registra el fallo, conserva intento y cursor anterior, sin otra llamada`, async () => {
      const provider = invalidCursorProvider(bad);
      const { deps, runId, store } = await setup(provider, cursorTarget.username, 100, 10);
      const out = await collect(deps, runId);
      expect(out).toMatchObject({ stopReason: "provider_error", uniqueReceived: 25, attempts: 3 });
      expect((out as { detail?: string }).detail).toMatch(reason);
      const run = store.snapshot(runId);
      expect(run.cursor).toBe(FIRST_CURSOR); // cursor anterior intacto
      expect(run.pages).toHaveLength(1); // la página no se confirmó
      expect(run.followers).toHaveLength(25);
      expect(run.attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "failed"]);
      expect(run.attempts[2]?.error).toMatch(reason);
      expect(provider.calls).toHaveLength(3); // no inició otra llamada
    });
  }

  it("commitPage directo con cursor inválido: InvalidCursor y estado intacto", async () => {
    const store = new MemoryRunStore();
    await createRun(store, {
      id: "r",
      username: cursorTarget.username,
      requested: 100,
      budgetMaxCalls: 5,
    });
    const resolve = await store.reserveAttempt("r", 0, { kind: "resolve" });
    if (resolve.kind !== "reserved") throw new Error("reserva");
    await store.commitResolve("r", resolve.lease, cursorTarget);
    const res = await store.reserveAttempt("r", 0, { kind: "page", cursor: null });
    if (res.kind !== "reserved") throw new Error("reserva");
    const before = store.snapshot("r");
    for (const [, bad] of INVALID_CURSORS) {
      await expect(
        store.commitPage("r", res.lease, { users: [], nextCursor: bad, limited: false }),
      ).rejects.toBeInstanceOf(InvalidCursor);
    }
    expect(store.snapshot("r")).toEqual(before);
  });
});

describe("entregas vinculadas a su solicitud (memoria)", () => {
  const request = (extra: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
    epoch: 0,
    baseRevision: 0,
    baseAttempts: 0,
    ...extra,
  });

  it("pausa antes de reservar: si otra entrega publica el resultado, no reserva ni llama", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const reached = deferred();
    const resume = deferred();
    const paused = {
      ...deps,
      beforeReserve: async () => {
        reached.resolve();
        await resume.promise;
      },
    };
    try {
      const d1 = collect(paused, runId, request());
      await reached.promise;
      const out2 = await collect(deps, runId, request());
      expect(out2).toMatchObject({ stopReason: "target_reached", attempts: 4 });
      const published = store.snapshot(runId);
      resume.resolve();
      expect(await d1).toEqual(out2);
      expect(store.snapshot(runId)).toEqual(published); // revisión, intentos y cursor intactos
      expect(provider.calls).toHaveLength(4);
    } finally {
      resume.resolve();
    }
  });

  it("caída entre el fallo y el cierre: la reentrega conserva el fallo sin volver a llamar", async () => {
    const provider = caseB();
    const { deps, runId, store } = await setup(provider, openTarget.username, 75, 10);
    const a = pausedAtFinish(deps, "provider_error");
    const held = provider.hold(C25);
    void collect(a.deps, runId, request()); // queda detenida antes de cerrar: «caída»
    await held.called;
    held.fail("HTTP 500 de la página 2");
    await a.decided;
    const afterFailure = store.snapshot(runId);
    expect(afterFailure.outcome).toBeNull();

    const out = await collect(deps, runId, request());
    expect(out).toMatchObject({ stopReason: "provider_error", detail: "HTTP 500 de la página 2" });
    const run = store.snapshot(runId);
    expect(run.attempts).toEqual(afterFailure.attempts);
    expect(run.cursor).toBe(C25);
    expect(run.epoch).toBe(0);
    expect(provider.calls).toHaveLength(3); // no volvió a pedir la página 2

    // Una solicitud explícita posterior (base = intentos actuales) sí reintenta.
    const cont = request({ baseRevision: run.revision, baseAttempts: run.attempts.length });
    expect(await collect(deps, runId, cont)).toMatchObject({ stopReason: "target_reached" });
    expect(provider.pageCalls()).toEqual([null, C25, C25, C50]);
    a.resume();
  });

  it("job vencido: al entrar no reserva; entre páginas se detiene; en vuelo conserva la reserva", async () => {
    // a) Vencido al entrar.
    const p1 = caseB();
    const s1 = await setup(p1, openTarget.username, 75, 10);
    const expired = new AbortController();
    expired.abort();
    expect(await collect(s1.deps, s1.runId, request({ signal: expired.signal }))).toEqual({
      kind: "aborted",
      reserved: [],
    });
    expect(s1.store.snapshot(s1.runId).attempts).toEqual([]);
    expect(p1.calls).toEqual([]);

    // b) Vence entre la página 2 y la 3.
    const p2 = caseB();
    const s2 = await setup(p2, openTarget.username, 75, 10);
    const between = new AbortController();
    const out = await collect(
      {
        ...s2.deps,
        beforeReserve: (op) => {
          if (op === `page:${JSON.stringify(C50)}`) between.abort();
        },
      },
      s2.runId,
      request({ signal: between.signal }),
    );
    expect(out).toEqual({ kind: "aborted", reserved: [] });
    const run2 = s2.store.snapshot(s2.runId);
    expect(run2.attempts).toHaveLength(3);
    expect(run2.cursor).toBe(C50);
    expect(run2.outcome).toBeNull();
    expect(p2.pageCalls()).toEqual([null, C25]);

    // c) Vence con la petición de la página 2 en vuelo.
    const p3 = caseB();
    const s3 = await setup(p3, openTarget.username, 75, 10);
    const inFlight = new AbortController();
    const held = p3.hold(C25);
    const pending = collect(s3.deps, s3.runId, request({ signal: inFlight.signal }));
    await held.called;
    inFlight.abort();
    expect(await pending).toEqual({
      kind: "aborted",
      reserved: [{ attemptId: 3, operation: `page:${JSON.stringify(C25)}` }],
    });
    held.release(); // la respuesta tardía no se escribe
    await Promise.resolve();
    expect(s3.store.snapshot(s3.runId).attempts.at(-1)).toMatchObject({
      id: 3,
      status: "reserved",
    });
    expect(await recoverInterrupted(s3.store, s3.runId, 3)).toBe(1);
  });
});
