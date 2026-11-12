import type { SourceAdapter } from "../ports/source-adapter";

/** Archivos CSV cargados por el equipo. */
export const csvAdapter: SourceAdapter = {
  key: "csv",
  name: "Carga de CSV",
  legalBasis: "manual",
  capabilities: ["discover"],
  // biome-ignore lint/correctness/useYield: se implementa en la fase 1
  async *discover() {
    throw new Error("Adaptador pendiente: se implementa en la fase 1");
  },
};
