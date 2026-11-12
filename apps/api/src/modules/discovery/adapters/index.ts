import type { SourceAdapter } from "../ports/source-adapter";
import { csvAdapter } from "./csv";
import { invimaAdapter } from "./invima";
import { repsAdapter } from "./reps";
import { websiteAdapter } from "./website";

/** Registro de fuentes del MVP. Google Places e Instagram llegan en la fase 2. */
export const adapters: readonly SourceAdapter[] = [
  repsAdapter,
  invimaAdapter,
  csvAdapter,
  websiteAdapter,
];

export function getAdapter(key: string): SourceAdapter {
  const adapter = adapters.find((a) => a.key === key);
  if (!adapter) throw new Error(`Fuente desconocida: ${key}`);
  return adapter;
}
