import { companyListQuerySchema } from "@icmspy/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import type { AuthVariables } from "../auth";
import { getCompany, listCompanies } from "./service";

export function companiesRoutes(ctx: AppContext) {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/", async (c) => {
      const query = companyListQuerySchema.safeParse(c.req.query());
      if (!query.success) return c.json({ error: "Filtros inválidos" }, 400);
      return c.json(await listCompanies(ctx.db, query.data));
    })
    .get("/:id", async (c) => {
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "No encontrada" }, 404);
      const company = await getCompany(ctx.db, id.data);
      return company ? c.json(company) : c.json({ error: "No encontrada" }, 404);
    });
}
