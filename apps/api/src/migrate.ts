import { fileURLToPath } from "node:url";
import { runMigrations } from "@icmspy/db";
import { loadEnv } from "./env";

const env = loadEnv();
const folder =
  env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

await runMigrations(env.DATABASE_URL, folder);
console.log("Migraciones aplicadas");
