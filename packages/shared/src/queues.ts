/**
 * Colas de pg-boss del alcance actual (extraer, validar y mostrar).
 * Las colas de envío y WhatsApp quedan para fases futuras.
 */
export const QUEUES = {
  importDataset: "import.dataset",
  importCsv: "import.csv",
  companiesResolve: "companies.resolve",
  enrichCrawlSite: "enrich.crawl_site",
  verifyEmail: "verify.email",
  instagramCollect: "instagram.collect",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  "import.dataset": { adapter: string; searchRunId: string };
  "import.csv": { searchRunId: string; fileKey: string };
  "companies.resolve": { sourceRecordId: string };
  "enrich.crawl_site": { companyId: string; domain: string };
  "verify.email": { contactPointId: string };
  /**
   * Una solicitud de recolección de seguidores. `baseRevision` y `baseEpoch` son los de la
   * ejecución al encolar: distinguen una reentrega del mismo trabajo de una nueva solicitud.
   */
  "instagram.collect": {
    runId: string;
    baseRevision: number;
    baseEpoch: number;
    /** Intentos que ya existían: los posteriores pertenecen a esta solicitud. */
    baseAttempts: number;
  };
}
