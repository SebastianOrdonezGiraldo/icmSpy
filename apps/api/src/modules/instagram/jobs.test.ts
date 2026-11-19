/** Registro de la cola de Instagram en el worker (sin base de datos ni red). */
import { QUEUES } from "@icmspy/shared";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../context";
import { registerInstagramJobs } from "./jobs";

function ctxWith(env: Partial<AppContext["env"]>) {
  const work = vi.fn(async (_name: string, _handler: unknown) => "worker-id");
  const ctx = {
    env: { NODE_ENV: "development", INSTAGRAM_PROVIDER: "disabled", ...env },
    pool: {},
    queue: { work },
  } as unknown as AppContext;
  return { ctx, work };
}

describe("registerInstagramJobs", () => {
  it("por defecto (disabled) no registra la cola", async () => {
    const { ctx, work } = ctxWith({});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await registerInstagramJobs(ctx);
    expect(work).not.toHaveBeenCalled();
  });

  it("el proveedor sintético solo se admite fuera de producción", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prod = ctxWith({ NODE_ENV: "production", INSTAGRAM_PROVIDER: "fake" });
    await expect(registerInstagramJobs(prod.ctx)).rejects.toThrow(/producción/);
    expect(prod.work).not.toHaveBeenCalled();

    const local = ctxWith({ NODE_ENV: "development", INSTAGRAM_PROVIDER: "fake" });
    await registerInstagramJobs(local.ctx);
    expect(local.work).toHaveBeenCalledTimes(1);
    expect(local.work.mock.calls[0]?.[0]).toBe(QUEUES.instagramCollect);
  });
});
