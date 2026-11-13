import type { SourceAdapter } from "../ports/source-adapter";

/** Crawler del sitio propio de cada empresa. Respeta robots.txt y solo lee páginas de contacto. */
export const websiteAdapter: SourceAdapter = {
  key: "website",
  name: "Sitio web de la empresa",
  legalBasis: "own_website",
  operational: false,
  capabilities: ["enrich"],
  async enrich() {
    throw new Error("Adaptador pendiente: se implementa en la fase 1");
  },
};
