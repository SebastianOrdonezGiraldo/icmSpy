import type { SourceAdapter } from "../ports/source-adapter";

/** Registro Especial de Prestadores de Servicios de Salud: IPS y clínicas. API Socrata de datos.gov.co. */
export const repsAdapter: SourceAdapter = {
  key: "reps",
  name: "REPS (datos.gov.co)",
  legalBasis: "open_data",
  capabilities: ["discover"],
  // biome-ignore lint/correctness/useYield: se implementa en la fase 1
  async *discover() {
    throw new Error("Adaptador pendiente: se implementa en la fase 1");
  },
};
