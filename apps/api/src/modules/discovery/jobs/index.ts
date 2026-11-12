import { QUEUES } from "@icmspy/shared";
import type { AppContext } from "../../../context";
import { getAdapter } from "../adapters";

/** Jobs del motor de descubrimiento. La lógica real llega en la fase 1. */
export async function registerDiscoveryJobs(ctx: AppContext) {
  await ctx.queue.work(QUEUES.importDataset, async ({ adapter, searchRunId }) => {
    const source = getAdapter(adapter);
    console.log(`[import.dataset] ${source.key} run=${searchRunId}: pendiente de implementar`);
  });

  await ctx.queue.work(QUEUES.importCsv, async ({ searchRunId }) => {
    console.log(`[import.csv] run=${searchRunId}: pendiente de implementar`);
  });
}
