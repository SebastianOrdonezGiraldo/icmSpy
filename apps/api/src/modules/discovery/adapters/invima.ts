import type { SourceAdapter } from "../ports/source-adapter";

/** Titulares e importadores de dispositivos médicos: distribuidores potenciales. */
export const invimaAdapter: SourceAdapter = {
  key: "invima",
  name: "INVIMA (datos.gov.co)",
  legalBasis: "open_data",
  capabilities: ["discover"],
  // biome-ignore lint/correctness/useYield: se implementa en la fase 1
  async *discover() {
    throw new Error("Adaptador pendiente: se implementa en la fase 1");
  },
};
