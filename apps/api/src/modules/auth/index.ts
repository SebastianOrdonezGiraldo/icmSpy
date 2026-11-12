import { type Db, schema } from "@icmspy/db";
import { USER_ROLES, type UserRole } from "@icmspy/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../../env";

interface AuthDeps {
  db: Db;
  env: Pick<Env, "APP_URL" | "BETTER_AUTH_SECRET">;
  /** Solo el script de alta de usuarios lo activa. */
  allowSignUp?: boolean;
}

/**
 * Login propio con correo y contraseña. El registro público está cerrado:
 * los usuarios se crean con `pnpm seed:admin`.
 */
export function createAuth({ db, env, allowSignUp = false }: AuthDeps) {
  return betterAuth({
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, disableSignUp: !allowSignUp, minPasswordLength: 8 },
    user: {
      additionalFields: {
        role: { type: [...USER_ROLES], defaultValue: "comercial", input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7 },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth["$Infer"]["Session"]["user"];

export type AuthVariables = { user: SessionUser };

/** Exige sesión válida y deja el usuario en `c.get("user")`. */
export function requireAuth(auth: Auth): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "No autenticado" }, 401);
    c.set("user", session.user);
    await next();
  };
}

export function requireRole(role: UserRole): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (c.get("user").role !== role) return c.json({ error: "Sin permiso" }, 403);
    await next();
  };
}
