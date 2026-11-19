/**
 * Contrato de `RunStore` probado directamente (sin recolector ni proveedor): cada escritura
 * valida su permiso dentro de la operación atómica y, si lo rechaza, no cambia nada.
 */
import { describe, expect, it } from "vitest";
import { createRun } from "./collect";
import { syntheticFollowers } from "./fake-provider";
import { type Lease, LeaseMismatch, type Reservation } from "./rules";
import { MemoryRunStore } from "./store";
import type { Cursor, FollowersPage, TargetAccount } from "./types";

const target: TargetAccount = {
  pk: "100000002",
  username: "cuenta_abierta_demo",
  followerCount: 8_852,
  isPrivate: false,
  isVerified: false,
};

const page = (from: number, nextCursor: Cursor | null): FollowersPage => ({
  users: syntheticFollowers(from, 25),
  nextCursor,
  limited: false,
});

function leaseOf(r: Reservation): Lease {
  if (r.kind !== "reserved") throw new Error(`Reserva no concedida: ${r.kind}`);
  return r.lease;
}

async function newRun(store: MemoryRunStore, id: string) {
  await createRun(store, { id, username: target.username, requested: 100, budgetMaxCalls: 10 });
}

/** Ejecución con la cuenta resuelta (intento 1) y lista para pedir la primera página. */
async function resolvedRun(store: MemoryRunStore, id: string) {
  await newRun(store, id);
  const lease = leaseOf(await store.reserveAttempt(id, 0, { kind: "resolve" }));
  await store.commitResolve(id, lease, target);
}

/** El rechazo deja idénticas las ejecuciones indicadas: revisión y reserva original incluidas. */
async function rejectsIntact(
  store: MemoryRunStore,
  runIds: string[],
  write: () => Promise<unknown>,
) {
  const before = runIds.map((id) => store.snapshot(id));
  await expect(write()).rejects.toBeInstanceOf(LeaseMismatch);
  expect(runIds.map((id) => store.snapshot(id))).toEqual(before);
}

describe("RunStore: validación del permiso en cada confirmación o fallo", () => {
  it("commitResolve con permiso de página: rechazado; la página se confirma después", async () => {
    const store = new MemoryRunStore();
    await resolvedRun(store, "run-1");
    const pageLease = leaseOf(
      await store.reserveAttempt("run-1", 0, { kind: "page", cursor: null }),
    );

    await rejectsIntact(store, ["run-1"], () => store.commitResolve("run-1", pageLease, target));
    // Permiso manipulado: dice "resolve" pero apunta al intento de página.
    const forged: Lease = { ...pageLease, operation: { kind: "resolve" } };
    await rejectsIntact(store, ["run-1"], () => store.commitResolve("run-1", forged, target));
    expect(store.snapshot("run-1").attempts.at(-1)).toMatchObject({ id: 2, status: "reserved" });

    await store.commitPage("run-1", pageLease, page(1, "c2"));
    const run = store.snapshot("run-1");
    expect(run.attempts.at(-1)).toMatchObject({ id: 2, status: "succeeded" });
    expect(run.pages.map((p) => p.requestCursor)).toEqual([null]);
    expect(run.followers).toHaveLength(25);
  });

  it("commitPage con permiso de resolución: rechazado; la resolución se confirma después", async () => {
    const store = new MemoryRunStore();
    await newRun(store, "run-1");
    const resolveLease = leaseOf(await store.reserveAttempt("run-1", 0, { kind: "resolve" }));

    await rejectsIntact(store, ["run-1"], () =>
      store.commitPage("run-1", resolveLease, page(1, "c2")),
    );
    const forged: Lease = { ...resolveLease, operation: { kind: "page", cursor: null } };
    await rejectsIntact(store, ["run-1"], () => store.commitPage("run-1", forged, page(1, "c2")));
    expect(store.snapshot("run-1").attempts).toEqual([
      { id: 1, operation: "resolve", kind: "resolve", status: "reserved" },
    ]);

    await store.commitResolve("run-1", resolveLease, target);
    const run = store.snapshot("run-1");
    expect(run.target).toEqual(target);
    expect(run.attempts[0]?.status).toBe("succeeded");
    expect(run.pages).toEqual([]);
  });

  it('commitPage con otro cursor: null y el texto "null" no se confunden', async () => {
    const store = new MemoryRunStore();
    await resolvedRun(store, "run-1");

    // Reserva de la primera página (cursor null); permiso manipulado con el texto "null".
    const first = leaseOf(await store.reserveAttempt("run-1", 0, { kind: "page", cursor: null }));
    const asText: Lease = { ...first, operation: { kind: "page", cursor: "null" } };
    await rejectsIntact(store, ["run-1"], () => store.commitPage("run-1", asText, page(1, "null")));
    await store.commitPage("run-1", first, page(1, "null")); // la fuente devuelve el texto "null"

    // Reserva de la segunda página (cursor texto "null"); permiso manipulado con null.
    const second = leaseOf(
      await store.reserveAttempt("run-1", 0, { kind: "page", cursor: "null" }),
    );
    const asNull: Lease = { ...second, operation: { kind: "page", cursor: null } };
    await rejectsIntact(store, ["run-1"], () => store.commitPage("run-1", asNull, page(26, "c3")));
    await store.commitPage("run-1", second, page(26, "c3"));

    const run = store.snapshot("run-1");
    expect(run.pages.map((p) => [p.requestCursor, p.nextCursor])).toEqual([
      [null, "null"],
      ["null", "c3"],
    ]);
    expect(run.attempts.map((a) => [a.operation, a.status])).toEqual([
      ["resolve", "succeeded"],
      ["page:null", "succeeded"],
      ['page:"null"', "succeeded"],
    ]);
    expect(run.followers).toHaveLength(50);
  });

  it("commitPage con permiso de otra ejecución (mismo attemptId): rechazado en ambas", async () => {
    const store = new MemoryRunStore();
    await resolvedRun(store, "run-1");
    await resolvedRun(store, "run-2");
    const lease1 = leaseOf(await store.reserveAttempt("run-1", 0, { kind: "page", cursor: null }));
    const lease2 = leaseOf(await store.reserveAttempt("run-2", 0, { kind: "page", cursor: null }));
    expect(lease1.attemptId).toBe(lease2.attemptId); // solo el runId los distingue

    await rejectsIntact(store, ["run-1", "run-2"], () =>
      store.commitPage("run-1", lease2, page(1, "c2")),
    );

    await store.commitPage("run-1", lease1, page(1, "c2"));
    await store.commitPage("run-2", lease2, page(101, "d2"));
    expect(store.snapshot("run-1").followers[0]?.pk).toBe(syntheticFollowers(1, 1)[0]?.pk);
    expect(store.snapshot("run-2").followers[0]?.pk).toBe(syntheticFollowers(101, 1)[0]?.pk);
  });

  it("failAttempt con permiso de otra ejecución: rechazado; el fallo legítimo se registra", async () => {
    const store = new MemoryRunStore();
    await resolvedRun(store, "run-1");
    await resolvedRun(store, "run-2");
    const lease1 = leaseOf(await store.reserveAttempt("run-1", 0, { kind: "page", cursor: null }));
    const lease2 = leaseOf(await store.reserveAttempt("run-2", 0, { kind: "page", cursor: null }));

    await rejectsIntact(store, ["run-1", "run-2"], () =>
      store.failAttempt("run-1", lease2, "HTTP 500 ajeno"),
    );

    const before = store.snapshot("run-1").revision;
    expect(await store.failAttempt("run-1", lease1, "HTTP 500 simulado")).toBe(before + 1);
    expect(store.snapshot("run-1").attempts.at(-1)).toMatchObject({
      status: "failed",
      error: "HTTP 500 simulado",
    });
    // La reserva de la otra ejecución sigue intacta y se confirma con su propio permiso.
    await store.commitPage("run-2", lease2, page(101, "d2"));
    expect(store.snapshot("run-2").attempts.at(-1)).toMatchObject({ status: "succeeded" });
  });
});
