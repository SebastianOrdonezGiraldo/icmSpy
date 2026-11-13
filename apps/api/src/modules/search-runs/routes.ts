import {
  type CreateSearchRunResponse,
  searchCriteriaSchema,
  searchRunListQuerySchema,
  searchRunResultsQuerySchema,
} from "@icmspy/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { type AuthVariables, requireRole } from "../auth";
import { SEARCH_RUN_ROLES } from "./presets";
import { getSearchRunResults } from "./results";
import { createSearchRun, getSearchRun, listSearchRuns, toSearchRunDto } from "./service";

export function searchRunsRoutes(ctx: AppContext) {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/", async (c) => {
      const query = searchRunListQuerySchema.safeParse(c.req.query());
      if (!query.success) return c.json({ error: "Parámetros inválidos" }, 400);
      const runs = await listSearchRuns(ctx, query.data.limit);
      return c.json(runs.map(toSearchRunDto));
    })
    .post("/", requireRole(...SEARCH_RUN_ROLES), async (c) => {
      // Solo JSON: un formulario de otro sitio no puede enviarlo sin preflight CORS.
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        return c.json({ error: "Se esperaba JSON" }, 415);
      }
      // Solo palabra clave y códigos DANE; los códigos se validan contra DIVIPOLA
      // antes de consultar ninguna fuente.
      const body = searchCriteriaSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json(
          {
            error: body.error.issues[0]?.message ?? "Criterios inválidos",
            fields: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
          400,
        );
      }
      const { run, created } = await createSearchRun(ctx, body.data, c.get("user").id);
      const response: CreateSearchRunResponse = { run: toSearchRunDto(run), created };
      return c.json(response, created ? 202 : 200);
    })
    .get("/:id", async (c) => {
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "No encontrada" }, 404);
      const run = await getSearchRun(ctx, id.data);
      return run ? c.json(toSearchRunDto(run)) : c.json({ error: "No encontrada" }, 404);
    })
    .get("/:id/results", async (c) => {
      const id = z.uuid().safeParse(c.req.param("id"));
      const query = searchRunResultsQuerySchema.safeParse(c.req.query());
      if (!id.success) return c.json({ error: "No encontrada" }, 404);
      if (!query.success) return c.json({ error: "Parámetros inválidos" }, 400);
      const run = await getSearchRun(ctx, id.data);
      if (!run) return c.json({ error: "No encontrada" }, 404);
      return c.json(
        await getSearchRunResults(ctx.db, run.id, query.data.page, query.data.pageSize),
      );
    });
}
