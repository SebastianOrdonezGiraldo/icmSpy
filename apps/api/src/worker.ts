import { createContext } from "./context";
import { loadEnv } from "./env";
import { registerDiscoveryJobs } from "./modules/discovery";
import { registerEnrichmentJobs } from "./modules/enrichment";

// Proceso aparte de la API: un crawl pesado no ralentiza la interfaz y,
// si el worker se cae, la web sigue funcionando.
const ctx = createContext(loadEnv());

await ctx.queue.start();
await registerDiscoveryJobs(ctx);
await registerEnrichmentJobs(ctx);
console.log("icmSpy worker escuchando jobs");

async function shutdown() {
  await ctx.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
