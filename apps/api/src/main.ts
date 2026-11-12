import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createContext } from "./context";
import { loadEnv } from "./env";
import { syncSources } from "./modules/discovery";

const env = loadEnv();
const ctx = createContext(env);

// La API solo encola jobs; quien los ejecuta es el proceso worker.
await ctx.queue.start();
await syncSources(ctx.db);

const server = serve({ fetch: createApp(ctx).fetch, hostname: env.HOST, port: env.PORT }, (info) =>
  console.log(`icmSpy API en http://${info.address}:${info.port}`),
);

async function shutdown() {
  server.close();
  await ctx.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
