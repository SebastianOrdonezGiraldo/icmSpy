import { createDb, type Db } from "@icmspy/db";
import type { Env } from "./env";
import { createQueue, type Queue } from "./lib/queue";
import { type Auth, createAuth } from "./modules/auth";

/** Dependencias compartidas por la API y el worker. */
export interface AppContext {
  env: Env;
  db: Db;
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
    queue,
    auth,
    async close() {
      await queue.stop();
      await pool.end();
    },
  };
}
