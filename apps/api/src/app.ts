import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { AppContext } from "./context";
import { type AuthVariables, requireAuth } from "./modules/auth";
import { companiesRoutes } from "./modules/companies";
import { adapters } from "./modules/discovery";

export function createApp(ctx: AppContext) {
  const app = new Hono();
  app.use(logger());
  app.use(secureHeaders());

  app.get("/api/health", async (c) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "error" }, 503);
    }
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => ctx.auth.handler(c.req.raw));

  const api = new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(ctx.auth))
    .get("/me", (c) => c.json(c.get("user")))
    .get("/sources", (c) =>
      c.json(
        adapters.map(({ key, name, legalBasis, capabilities }) => ({
          key,
          name,
          legalBasis,
          capabilities,
        })),
      ),
    )
    .route("/companies", companiesRoutes(ctx));

  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: "No encontrado" }, 404));

  // En producción la misma API sirve el frontend compilado.
  if (ctx.env.WEB_DIST_DIR) {
    const root = ctx.env.WEB_DIST_DIR;
    app.use("*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Error interno" }, 500);
  });

  return app;
}
