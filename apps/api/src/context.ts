import { createDb, type Db } from "@icmspy/db";
import type pg from "pg";
import type { Env } from "./env";
import { createQueue, type Queue } from "./lib/queue";
import { type Auth, createAuth } from "./modules/auth";

/** Dependencias compartidas por la API y el worker. */
export interface AppContext {
  env: Env;
  db: Db;
  /** Pool de `db`. Solo para transacciones que deben compartir cliente con la cola. */
  pool: pg.Pool;
  queue: Queue;
  auth: Auth;
  close(): Promise<void>;
}

export function createContext(env: Env): AppContext {
  const { db, pool } = createDb(env.DATABASE_URL);
  const queue = createQueue(env.DATABASE_URL);
  const auth = createAuth({ db, env });
  return {
    env,
    db,
    pool,
    queue,
    auth,
    async close() {
      await queue.stop();
      await pool.end();
    },
  };
}
