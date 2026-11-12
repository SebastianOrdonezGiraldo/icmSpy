import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/worker.ts", "src/migrate.ts", "src/seed-admin.ts"],
  format: "esm",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Los paquetes del monorepo se publican como TypeScript: se empaquetan aquí.
  noExternal: [/^@icmspy\//],
});
