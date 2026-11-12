/** Normalización, deduplicación y validación de correos y teléfonos. */
import { QUEUES } from "@icmspy/shared";
import type { AppContext } from "../../context";

export * from "./normalize";

export async function registerEnrichmentJobs(ctx: AppContext) {
  await ctx.queue.work(QUEUES.companiesResolve, async ({ sourceRecordId }) => {
    console.log(`[companies.resolve] record=${sourceRecordId}: pendiente de implementar`);
  });
  await ctx.queue.work(QUEUES.enrichCrawlSite, async ({ domain }) => {
    console.log(`[enrich.crawl_site] ${domain}: pendiente de implementar`);
  });
  await ctx.queue.work(QUEUES.verifyEmail, async ({ contactPointId }) => {
    console.log(`[verify.email] contact=${contactPointId}: pendiente de implementar`);
  });
}
