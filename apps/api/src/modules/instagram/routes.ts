import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import type { AuthVariables } from "../auth";
import {
  buildDemoResult,
  DEMO_BUDGET,
  DEMO_EXAMPLES,
  DEMO_REQUESTED,
  parseInstagramProfileUrl,
} from "./demo";
import { startInstagramCollection } from "./jobs";
import { PgRunStore } from "./pg-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Demo con datos de prueba: crear una búsqueda desde la URL de un perfil y consultar su
 * progreso y resultado. Solo con INSTAGRAM_PROVIDER=fake y fuera de producción.
 */
export function instagramDemoRoutes(ctx: AppContext) {
  const enabled = ctx.env.INSTAGRAM_PROVIDER === "fake" && ctx.env.NODE_ENV !== "production";
  const store = new PgRunStore(ctx.pool);
  const disabled = { error: "La demo de Instagram está desactivada (INSTAGRAM_PROVIDER)" };

  return new Hono<{ Variables: AuthVariables }>()
    .get("/config", (c) =>
      c.json({ enabled, examples: DEMO_EXAMPLES, requested: DEMO_REQUESTED, budget: DEMO_BUDGET }),
    )
    .post("/searches", async (c) => {
      if (!enabled) return c.json(disabled, 404);
      const body = z.object({ profileUrl: z.string().max(300) }).safeParse(await c.req.json());
      const username = body.success ? parseInstagramProfileUrl(body.data.profileUrl) : null;
      if (!username) {
        return c.json(
          { error: "Pegue la URL de un perfil, p. ej. https://www.instagram.com/usuario/" },
          400,
        );
      }
      const { runId } = await startInstagramCollection(
        { pool: ctx.pool, queue: ctx.queue },
        { username, requested: DEMO_REQUESTED, budgetMaxCalls: DEMO_BUDGET },
      );
      return c.json({ runId }, 201);
    })
    .get("/searches/:id", async (c) => {
      if (!enabled) return c.json(disabled, 404);
      const id = c.req.param("id");
      if (!UUID.test(id)) return c.json({ error: "Búsqueda no válida" }, 400);
      try {
        return c.json(buildDemoResult(await store.snapshot(id)));
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("No existe la ejecución")) {
          return c.json({ error: "No encontrada" }, 404);
        }
        throw err;
      }
    });
}
