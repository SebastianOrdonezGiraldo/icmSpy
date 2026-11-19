import { Hono } from "hono";
import type { AppContext } from "../../context";
import type { AuthVariables } from "../auth";
import { getPilotRun, listPilotRuns } from "./service";

/** Solo lectura. Desactivado si INSTAGRAM_PILOT_RUNS_DIR no está configurado. */
export function instagramPilotRoutes(ctx: AppContext) {
  const root = ctx.env.INSTAGRAM_PILOT_RUNS_DIR;
  return new Hono<{ Variables: AuthVariables }>()
    .get("/runs", async (c) => {
      if (!root) return c.json({ enabled: false, runs: [] });
      return c.json({ enabled: true, runs: await listPilotRuns(root) });
    })
    .get("/runs/:runId", async (c) => {
      if (!root) return c.json({ error: "Visor del piloto desactivado" }, 404);
      const run = await getPilotRun(root, c.req.param("runId"));
      return run ? c.json(run) : c.json({ error: "No encontrada" }, 404);
    });
}
