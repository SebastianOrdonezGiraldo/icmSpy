/**
 * Crea o actualiza un usuario. El registro público está cerrado, así que
 * esta es la única forma de dar acceso.
 *
 *   SEED_EMAIL=... SEED_PASSWORD=... SEED_NAME=... SEED_ROLE=admin pnpm seed:admin
 */
import { createDb, user } from "@icmspy/db";
import { USER_ROLES } from "@icmspy/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadEnv } from "./env";
import { createAuth } from "./modules/auth";

const env = loadEnv();
const input = z
  .object({
    SEED_EMAIL: z.email(),
    SEED_PASSWORD: z.string().min(8),
    SEED_NAME: z.string().min(1).default("Administrador"),
    SEED_ROLE: z.enum(USER_ROLES).default("admin"),
  })
  .parse(process.env);

const { db, pool } = createDb(env.DATABASE_URL);
const auth = createAuth({ db, env, allowSignUp: true });
const email = input.SEED_EMAIL.toLowerCase();

const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
if (!existing) {
  await auth.api.signUpEmail({
    body: { email, password: input.SEED_PASSWORD, name: input.SEED_NAME },
  });
}
await db.update(user).set({ role: input.SEED_ROLE }).where(eq(user.email, email));

console.log(
  existing
    ? `El usuario ${email} ya existía; rol actualizado a ${input.SEED_ROLE} (la contraseña no cambió)`
    : `Usuario ${email} creado con rol ${input.SEED_ROLE}`,
);
await pool.end();
