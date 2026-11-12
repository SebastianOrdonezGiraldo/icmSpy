import { fileURLToPath } from "node:url";
import { runMigrations } from "./index";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Falta DATABASE_URL");

const folder =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url));

await runMigrations(url, folder);
console.log("Migraciones aplicadas");
