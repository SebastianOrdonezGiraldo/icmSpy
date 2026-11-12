import { type JobPayloads, QUEUES, type QueueName } from "@icmspy/shared";
import { PgBoss } from "pg-boss";

/**
 * Único punto de contacto con pg-boss. Si algún día se cambia a otra cola,
 * el cambio queda en este archivo.
 */
export type Queue = ReturnType<typeof createQueue>;

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
    send<N extends QueueName>(
      name: N,
      data: JobPayloads[N],
      options?: { singletonKey?: string; retryLimit?: number },
    ) {
      return boss.send(name, data, { retryLimit: 3, retryBackoff: true, ...options });
    },
    work<N extends QueueName>(
      name: N,
      handler: (data: JobPayloads[N], jobId: string) => Promise<void>,
    ) {
      return boss.work<JobPayloads[N]>(name, async (jobs) => {
        for (const job of jobs) await handler(job.data, job.id);
      });
    },
  };
}
