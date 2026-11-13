/**
 * Motor de descubrimiento. No conoce nada de lo que se haga después con las
 * empresas: solo trae registros crudos con su procedencia.
 */
export { adapters, getAdapter, searchableAdapters } from "./adapters";
export * from "./errors";
export { registerDiscoveryJobs } from "./jobs";
export type {
  CompanyRef,
  DiscoverHooks,
  RawRecord,
  ResolvedContact,
  ResolvedRecord,
  SearchQuery,
  SourceAdapter,
  SourceSnapshot,
} from "./ports/source-adapter";
export { syncSources } from "./sync-sources";
