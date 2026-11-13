import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema/index";

export * as schema from "./schema/index";
export * from "./schema/index";

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];

/** Base de datos o transacción: lo que aceptan las funciones que pueden correr dentro de una. */
export type DbExecutor = NodePgDatabase<typeof schema>;

/**
 * Ejecuta `fn` en una transacción sobre un único cliente del pool. Devuelve
 * también el cliente crudo para que otras librerías (pg-boss) escriban en la
 * misma transacción: si algo falla, se deshace todo junto.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (tx: DbExecutor, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(drizzle(client, { schema }), client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Aplica las migraciones pendientes de `migrationsFolder`. */
export async function runMigrations(connectionString: string, migrationsFolder: string) {
  const { db, pool } = createDb(connectionString);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
