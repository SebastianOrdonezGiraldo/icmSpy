import { type JobPayloads, QUEUES, type QueueName } from "@icmspy/shared";
import type pg from "pg";
import { PgBoss } from "pg-boss";

/**
 * Único punto de contacto con pg-boss. Si algún día se cambia a otra cola,
 * el cambio queda en este archivo.
 *
 * Las colas se crean con la política `standard`. En pg-boss 12 eso significa
 * que `singletonKey` por sí solo NO impide trabajos duplicados (solo lo hacen
 * las políticas short/singleton/stately/exclusive o `singletonSeconds`). La
 * unicidad de las búsquedas la garantiza la base de datos (índice único
 * parcial en `search_runs`), no la cola.
 */
export type Queue = ReturnType<typeof createQueue>;

/** Lo que el handler sabe del intento en curso. */
export interface JobAttemptInfo {
  id: string;
  /** 0 en el primer intento. */
  retryCount: number;
  retryLimit: number;
  /** Se aborta si pg-boss da el job por vencido. */
  signal: AbortSignal;
}

export const DEFAULT_RETRY_LIMIT = 2;

export function createQueue(connectionString: string) {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  boss.on("error", (err) => console.error("[pg-boss]", err));

  return {
    boss,
    async start() {
      await boss.start();
      for (const name of Object.values(QUEUES)) {
        await boss.createQueue(name);
      }
    },
    stop: () => boss.stop({ graceful: true }),
    /**
     * Encola un job. Con `client`, el INSERT del job corre en la transacción
     * abierta en ese cliente: si la transacción se deshace, el job no existe.
     */
    send<N extends QueueName>(
      name: N,
      data: JobPayloads[N],
      options?: {
        id?: string;
        retryLimit?: number;
        expireInSeconds?: number;
        client?: pg.PoolClient;
      },
    ) {
      const { client, ...rest } = options ?? {};
      return boss.send(name, data, {
        retryLimit: DEFAULT_RETRY_LIMIT,
        retryBackoff: true,
        ...rest,
        ...(client && {
          db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
        }),
      });
    },
    work<N extends QueueName>(
      name: N,
      handler: (data: JobPayloads[N], job: JobAttemptInfo) => Promise<void>,
    ) {
      const options = { includeMetadata: true } as const;
      return boss.work<JobPayloads[N], void, typeof options>(name, options, async (jobs) => {
        for (const job of jobs) {
          await handler(job.data, {
            id: job.id,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
            signal: job.signal,
          });
        }
      });
    },
    /** Estado del job en pg-boss, o null si ya no existe (borrado por retención). */
    async getJobState(name: QueueName, id: string) {
      const job = await boss.getJobById(name, id);
      return job?.state ?? null;
    },
  };
}
