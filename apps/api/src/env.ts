import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(3020),
  DATABASE_URL: z.url(),
  /** URL pública de la app, por ejemplo https://spy.midominio.com */
  APP_URL: z.url().default("http://localhost:5173"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET debe tener al menos 32 caracteres"),
  /** Carpeta con el frontend compilado. Vacío en desarrollo (lo sirve Vite). */
  WEB_DIST_DIR: z.string().optional(),
  MIGRATIONS_DIR: z.string().optional(),
  /**
   * Carpeta de ejecuciones del piloto local de Instagram (tools/instagram-pilot), p. ej.
   * %LOCALAPPDATA%\icmSpy\instagram-pilot\runs. Vacío = visor desactivado. Solo lectura.
   */
  INSTAGRAM_PILOT_RUNS_DIR: z.string().optional(),
  /**
   * Proveedor de la recolección de Instagram en el worker. `disabled` (por defecto) no registra
   * la cola; `fake` usa datos sintéticos y solo se admite fuera de producción (modo local).
   */
  INSTAGRAM_PROVIDER: z.enum(["disabled", "fake"]).default("disabled"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Configuración inválida:\n${issues.join("\n")}`);
  }
  return parsed.data;
}
