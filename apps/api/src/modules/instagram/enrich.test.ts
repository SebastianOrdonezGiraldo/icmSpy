/**
 * Enriquecimiento de perfiles (memoria): cada perfil público seleccionado es un intento con su
 * propia reserva y el mismo presupuesto; los privados nunca se consultan; los contactos se
 * guardan con su procedencia (botón o biografía).
 */
import { describe, expect, it } from "vitest";
import { collect, createRun, isInProgress } from "./collect";
import { FakeInstagramProvider, syntheticFollowers } from "./fake-provider";
import { MemoryRunStore } from "./store";
import type { FollowerProfile, TargetAccount } from "./types";

const target: TargetAccount = {
  pk: "100000009",
  username: "cuenta_enriquecida_demo",
  followerCount: 500,
  isPrivate: false,
  isVerified: false,
};
const users = syntheticFollowers(1, 25); // n % 3 === 0 son privados
const pk = (n: number) => String(9_000_000 + n);
const publicProfile = (
  p: Partial<Extract<FollowerProfile, { status: "ok" }>>,
): FollowerProfile => ({
  status: "ok",
  isPrivate: false,
  businessEmail: null,
  businessPhone: null,
  biography: null,
  ...p,
});

/** Perfiles: 1 con botones, 2 con biografía, 4 no encontrado, 5 ya privado, resto sin contacto. */
function newProvider(failOn?: Set<string>) {
  const profiles = new Map<string, FollowerProfile>();
  for (const n of [7, 8, 10, 11, 13, 14]) profiles.set(pk(n), publicProfile({ biography: "Hola" }));
  profiles.set(
    pk(1),
    publicProfile({
      businessEmail: "Contacto1@Negocio.example",
      businessPhone: "+57 601 555 0001",
    }),
  );
  profiles.set(pk(2), publicProfile({ biography: "Pedidos: ventas2@negocio.example" }));
  profiles.set(pk(5), publicProfile({ isPrivate: true }));
  return new FakeInstagramProvider(
    target,
    [{ cursor: null, page: { users, nextCursor: null, limited: false } }],
    failOn,
    profiles,
  );
}

async function setup(provider: FakeInstagramProvider, requested: number, budgetMaxCalls: number) {
  const store = new MemoryRunStore();
  await createRun(store, {
    id: "run",
    username: target.username,
    requested,
    budgetMaxCalls,
    enrichProfiles: true,
  });
  return { store, deps: { provider, store } };
}

describe("enriquecimiento de perfiles", () => {
  it("consulta solo los públicos seleccionados y guarda contactos con su procedencia", async () => {
    const provider = newProvider();
    const { store, deps } = await setup(provider, 10, 9);
    expect(await collect(deps, "run")).toMatchObject({ stopReason: "target_reached", attempts: 9 });
    // Seleccionados 1..10; privados 3, 6 y 9: nunca se consultan.
    expect(provider.profileCalls()).toEqual([1, 2, 4, 5, 7, 8, 10].map(pk));
    const run = store.snapshot("run");
    const byN = (n: number) => run.followers.find((f) => f.pk === pk(n));
    expect(byN(1)).toMatchObject({
      enrichment: "done",
      contacts: [
        {
          kind: "email",
          value: "contacto1@negocio.example",
          original: "Contacto1@Negocio.example",
          source: "button",
        },
        { kind: "phone", value: "+576015550001", original: "+57 601 555 0001", source: "button" },
      ],
    });
    expect(byN(2)?.contacts).toEqual([
      {
        kind: "email",
        value: "ventas2@negocio.example",
        original: "ventas2@negocio.example",
        source: "biography",
      },
    ]);
    expect(byN(3)).toMatchObject({ enrichment: "private", contacts: [] });
    expect(byN(4)).toMatchObject({ enrichment: "not_found", contacts: [] });
    expect(byN(5)).toMatchObject({ enrichment: "private", contacts: [] });
    expect(byN(7)).toMatchObject({ enrichment: "done", contacts: [] });
    // El excedente (11..25) no está seleccionado: queda pendiente.
    expect(byN(11)?.enrichment).toBe("pending");
    expect(run.attempts.filter((a) => a.kind === "profile")).toHaveLength(7);
  });

  it("sin presupuesto a mitad: budget_exhausted parcial; al ampliar solo consulta lo pendiente", async () => {
    const provider = newProvider();
    const { store, deps } = await setup(provider, 10, 5); // resolución + página + 3 perfiles
    expect(await collect(deps, "run")).toMatchObject({
      stopReason: "budget_exhausted",
      attempts: 5,
    });
    expect(provider.profileCalls()).toEqual([1, 2, 4].map(pk));

    await store.extend("run", { budgetMaxCalls: 9 });
    expect(await collect(deps, "run")).toMatchObject({ stopReason: "target_reached", attempts: 9 });
    expect(provider.profileCalls()).toEqual([1, 2, 4, 5, 7, 8, 10].map(pk)); // sin repetir
  });

  it("ampliar el objetivo selecciona y consulta el excedente ya guardado, sin pedir páginas", async () => {
    const provider = newProvider();
    const { store, deps } = await setup(provider, 10, 20);
    await collect(deps, "run");
    await store.extend("run", { requested: 12 });
    expect(await collect(deps, "run")).toMatchObject({ stopReason: "target_reached" });
    // 11 público se consulta; 12 es privado.
    expect(provider.profileCalls().slice(7)).toEqual([pk(11)]);
    expect(provider.pageCalls()).toEqual([null]);
  });

  it("error de la fuente en un perfil: provider_error; la reentrega del job no repite la llamada", async () => {
    const provider = newProvider(new Set([`profile:${pk(2)}`]));
    const { store, deps } = await setup(provider, 10, 20);
    expect(await collect(deps, "run")).toMatchObject({
      stopReason: "provider_error",
      detail: "HTTP 500 simulado",
    });
    const calls = provider.calls.length;
    // Reentrega del mismo job (con su solicitud): conserva la decisión sin volver a llamar.
    const run = store.snapshot("run");
    expect(
      await collect(deps, "run", { epoch: run.epoch, baseRevision: 0, baseAttempts: 0 }),
    ).toMatchObject({ stopReason: "provider_error" });
    expect(provider.calls).toHaveLength(calls);
  });

  it("dos entregas solapadas: la segunda recibe in_progress; el perfil se consulta una vez", async () => {
    const provider = newProvider();
    const { store, deps } = await setup(provider, 10, 20);
    const held = provider.holdProfile(pk(1));
    const first = collect(deps, "run");
    await held.called;
    const second = await collect(deps, "run");
    expect(isInProgress(second) && second.reserved.map((r) => r.operation)).toEqual([
      `profile:${JSON.stringify(pk(1))}`,
    ]);
    held.release();
    expect(await first).toMatchObject({ stopReason: "target_reached" });
    expect(provider.profileCalls().filter((p) => p === pk(1))).toHaveLength(1);
    expect(store.snapshot("run").followers[0]?.enrichment).toBe("done");
  });

  it("sin enriquecimiento activado no se consulta ningún perfil", async () => {
    const provider = newProvider();
    const store = new MemoryRunStore();
    await createRun(store, {
      id: "run",
      username: target.username,
      requested: 10,
      budgetMaxCalls: 9,
    });
    expect(await collect({ provider, store }, "run")).toMatchObject({ attempts: 2 });
    expect(provider.profileCalls()).toEqual([]);
    expect(store.snapshot("run").followers.every((f) => f.contacts.length === 0)).toBe(true);
  });
});
