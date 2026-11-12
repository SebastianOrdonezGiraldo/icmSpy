/**
 * Motor de descubrimiento. No conoce nada de lo que se haga después con las
 * empresas: solo trae registros crudos con su procedencia.
 */
export { adapters, getAdapter } from "./adapters";
export { registerDiscoveryJobs } from "./jobs";
export type { CompanyRef, RawRecord, SearchQuery, SourceAdapter } from "./ports/source-adapter";
export { syncSources } from "./sync-sources";
