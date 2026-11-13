import { QUEUES } from "@icmspy/shared";
import type { AppContext } from "../../../context";
import { getAdapter } from "../adapters";
import { createImportDatasetHandler } from "./import-dataset";

/** Jobs del motor de descubrimiento. */
export async function registerDiscoveryJobs(ctx: AppContext) {
  await ctx.queue.work(
    QUEUES.importDataset,
    createImportDatasetHandler({ db: ctx.db, pool: ctx.pool, getAdapter }),
  );

  await ctx.queue.work(QUEUES.importCsv, async ({ searchRunId }) => {
    // Falla a propósito: un job sin implementar no debe quedar como completado.
    throw new Error(`[import.csv] run=${searchRunId}: la importación de CSV no está implementada`);
  });
}
