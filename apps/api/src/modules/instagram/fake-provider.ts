/** Proveedor falso con respuestas sintéticas (sin red). Registra cada llamada recibida. */
import type {
  Cursor,
  FollowerStub,
  FollowersPage,
  InstagramProvider,
  TargetAccount,
} from "./types";

export interface FakeCall {
  kind: "resolve" | "page";
  cursor?: Cursor | null;
}

/** Promesa controlable a mano (sin temporizadores). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Respuesta retenida: la llamada espera hasta `release()` (datos) o `fail()` (error). */
export interface HeldResponse {
  /** Se cumple cuando la fuente recibe la llamada retenida. */
  called: Promise<void>;
  release(): void;
  fail(message: string): void;
}

/** Clave de la resolución; no colisiona con cursores (siempre se serializan como JSON). */
const RESOLVE_KEY = "resolve";

export class FakeInstagramProvider implements InstagramProvider {
  readonly calls: FakeCall[] = [];
  private pages = new Map<string, FollowersPage>();
  private held = new Map<string, { called: () => void; gate: Promise<Error | null> }>();

  constructor(
    private readonly target: TargetAccount,
    pages: Array<{ cursor: Cursor | null; page: FollowersPage }>,
    private readonly failOn: Set<string> = new Set(),
  ) {
    for (const p of pages) this.pages.set(JSON.stringify(p.cursor), p.page);
  }

  async resolveAccount(username: string): Promise<TargetAccount> {
    this.calls.push({ kind: "resolve" });
    await this.waitIfHeld(RESOLVE_KEY);
    if (username !== this.target.username) throw new Error("Cuenta inexistente");
    return { ...this.target };
  }

  /** Retiene la próxima llamada con ese cursor hasta liberarla a mano. */
  hold(cursor: Cursor | null): HeldResponse {
    return this.holdKey(JSON.stringify(cursor));
  }

  /** Retiene la próxima resolución de cuenta hasta liberarla a mano. */
  holdResolve(): HeldResponse {
    return this.holdKey(RESOLVE_KEY);
  }

  private holdKey(key: string): HeldResponse {
    const called = deferred<void>();
    const gate = deferred<Error | null>();
    this.held.set(key, { called: () => called.resolve(), gate: gate.promise });
    return {
      called: called.promise,
      release: () => gate.resolve(null),
      fail: (message) => gate.resolve(new Error(message)),
    };
  }

  async followersPage(targetPk: string, cursor: Cursor | null): Promise<FollowersPage> {
    this.calls.push({ kind: "page", cursor });
    const key = JSON.stringify(cursor);
    await this.waitIfHeld(key);
    if (targetPk !== this.target.pk) throw new Error("Cuenta distinta");
    if (this.failOn.has(key)) throw new Error("HTTP 500 simulado");
    const page = this.pages.get(key);
    if (!page) throw new Error("Cursor desconocido para la fuente");
    return structuredClone(page);
  }

  private async waitIfHeld(key: string): Promise<void> {
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key); // solo la próxima llamada
    held.called();
    const error = await held.gate;
    if (error) throw error;
  }

  pageCalls(): Array<Cursor | null> {
    return this.calls.filter((c) => c.kind === "page").map((c) => c.cursor ?? null);
  }
}

/** Seguidores inventados: ids "9xxxxxx" y usuarios "seguidor_N"; cada `privateEvery` es privado. */
export function syntheticFollowers(from: number, count: number, privateEvery = 3): FollowerStub[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return {
      pk: String(9_000_000 + n),
      username: `seguidor_${n}`,
      isPrivate: n % privateEvery === 0,
    };
  });
}

/**
 * Proveedor sintético para el modo local explícito (INSTAGRAM_PROVIDER=fake): cualquier usuario
 * resuelve a una cuenta inventada con `pageCount` páginas de 25 seguidores inventados, propios de
 * esa cuenta (uno de cada cuatro es privado). Nunca usa la red; `delayMs` simula la latencia para
 * que el progreso sea visible en la demo. No debe usarse en producción.
 */
export class SyntheticInstagramProvider implements InstagramProvider {
  constructor(
    private readonly pageCount = 4,
    private readonly delayMs = 0,
  ) {}

  private async latency() {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  private static hash(text: string) {
    let hash = 0;
    for (const ch of text) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_000_000;
    return hash;
  }

  async resolveAccount(username: string): Promise<TargetAccount> {
    await this.latency();
    return {
      pk: String(800_000_000 + SyntheticInstagramProvider.hash(username)),
      username,
      followerCount: this.pageCount * 25,
      isPrivate: false,
      isVerified: false,
    };
  }

  async followersPage(targetPk: string, cursor: Cursor | null): Promise<FollowersPage> {
    await this.latency();
    const index = cursor === null ? 0 : Number(cursor.replace("sintetico-", ""));
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) {
      throw new Error("Cursor desconocido para el proveedor sintético");
    }
    const prefix = `seg${targetPk.slice(-4)}`;
    const users: FollowerStub[] = Array.from({ length: 25 }, (_, i) => {
      const n = index * 25 + i + 1;
      return {
        pk: `${targetPk}${String(n).padStart(4, "0")}`,
        username: `${prefix}_seguidor${n}`,
        isPrivate: n % 4 === 0,
      };
    });
    return {
      users,
      nextCursor: index + 1 < this.pageCount ? `sintetico-${index + 1}` : null,
      limited: false,
    };
  }
}
