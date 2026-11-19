import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPilotRun, listPilotRuns } from "./service";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "igpilot-"));
  const runId = "20261117T150000Z-perfil.ejemplo";
  await mkdir(join(root, runId));
  await writeFile(
    join(root, runId, "summary.json"),
    JSON.stringify({
      status: "stopped",
      stop_reason: "rate_limited",
      stop_reason_text: "429",
      updated_at: "2026-11-17T15:10:00+00:00",
      target: { username: "perfil.ejemplo" },
      counters: { unique_followers: 2 },
      contacts: { observations: 1 },
      files: { base: "C:\\Users\\x\\pilot.sqlite" },
    }),
  );
  await writeFile(
    join(root, runId, "followers.jsonl"),
    `${JSON.stringify({ user_id: "1", username: "a" })}\n{incompleta\n${JSON.stringify({ user_id: "2", username: "b" })}\n`,
  );
  await writeFile(
    join(root, runId, "contacts.jsonl"),
    `${JSON.stringify({ user_id: "1", kind: "email" })}\n`,
  );
  await mkdir(join(root, "otra-carpeta"));
  return { root, runId };
}

describe("visor del piloto de Instagram", () => {
  it("lista solo carpetas de ejecución con resumen", async () => {
    const { root, runId } = await fixture();
    const runs = await listPilotRuns(root);
    expect(runs.map((r) => r.runId)).toEqual([runId]);
    expect(runs[0]).toMatchObject({ target: "perfil.ejemplo", status: "stopped", contacts: 1 });
  });

  it("devuelve seguidores y contactos, ignora líneas rotas y oculta rutas locales", async () => {
    const { root, runId } = await fixture();
    const run = await getPilotRun(root, runId);
    expect(run?.followers.map((f) => f.user_id)).toEqual(["1", "2"]);
    expect(run?.contacts).toHaveLength(1);
    expect(run?.summary.files).toBeUndefined();
  });

  it("rechaza identificadores que no son de ejecución (sin recorrer rutas)", async () => {
    const { root } = await fixture();
    expect(await getPilotRun(root, "../..")).toBeNull();
    expect(await getPilotRun(root, "..\\secreto")).toBeNull();
    expect(await getPilotRun(root, "otra-carpeta")).toBeNull();
  });

  it("carpeta inexistente: lista vacía", async () => {
    expect(await listPilotRuns(join(tmpdir(), "no-existe-igpilot"))).toEqual([]);
  });
});
