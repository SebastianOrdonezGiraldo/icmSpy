import type { SourceAdapter } from "../ports/source-adapter";
import { csvAdapter } from "./csv";
import { invimaAdapter } from "./invima";
import { repsAdapter } from "./reps";
import { serviceSourceAdapters } from "./reps-services";
import { websiteAdapter } from "./website";

/** Registro de fuentes. Las no operativas están declaradas pero nunca se consultan. */
export const adapters: readonly SourceAdapter[] = [
  repsAdapter,
  ...serviceSourceAdapters,
  invimaAdapter,
  csvAdapter,
  websiteAdapter,
];

/**
 * Fuentes de prestadores que el buscador consulta: adaptadores operativos que
 * saben buscar e interpretar registros. Un esqueleto nunca aparece aquí.
 */
export function searchableAdapters(registry: readonly SourceAdapter[] = adapters) {
  return registry.filter(
    (a) =>
      a.operational &&
      (a.role ?? "providers") === "providers" &&
      a.capabilities.includes("discover") &&
      a.discover &&
      a.resolve,
  );
}

/** Fuentes de servicios operativas que cubren el departamento pedido. */
export function serviceAdaptersFor(
  departmentCode: string,
  registry: readonly SourceAdapter[] = adapters,
) {
  return registry.filter(
    (a) =>
      a.operational &&
      a.role === "services" &&
      a.discover &&
      a.resolveService &&
      a.serviceCoverage?.departmentCodes.includes(departmentCode),
  );
}

export function getAdapter(key: string): SourceAdapter {
  const adapter = adapters.find((a) => a.key === key);
  if (!adapter) throw new Error(`Fuente desconocida: ${key}`);
  return adapter;
}
