import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@icmspy/db";
import { sql } from "drizzle-orm";
import { syncSources } from "../modules/discovery";

/**
 * Base para pruebas de integración. Solo se usa si TEST_DATABASE_URL apunta a
 * una base cuyo nombre termina en `_test`: las pruebas vacían sus tablas.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function setupTestDb(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL debe apuntar a una base *_test (recibido: ${name})`);
  }
  await runMigrations(
    url,
    fileURLToPath(new URL("../../../../packages/db/migrations", import.meta.url)),
  );
  const { db, pool } = createDb(url);
  await syncSources(db);
  return { db, pool };
}

export async function resetData(db: ReturnType<typeof createDb>["db"]) {
  await db.execute(
    sql`truncate companies, source_records, search_runs, suppression_list, audit_log, data_provenance cascade`,
  );
}
