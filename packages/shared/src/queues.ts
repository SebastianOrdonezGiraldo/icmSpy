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
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  "import.dataset": { adapter: string; searchRunId: string };
  "import.csv": { searchRunId: string; fileKey: string };
  "companies.resolve": { sourceRecordId: string };
  "enrich.crawl_site": { companyId: string; domain: string };
  "verify.email": { contactPointId: string };
}
