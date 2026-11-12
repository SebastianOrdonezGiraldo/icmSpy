import { type Db, sources } from "@icmspy/db";
import { adapters } from "./adapters";

/** Mantiene el catálogo `sources` igual al registro de adaptadores. */
export async function syncSources(db: Db) {
  for (const a of adapters) {
    const values = {
      key: a.key,
      name: a.name,
      legalBasis: a.legalBasis,
      licenseUrl: a.licenseUrl ?? null,
    };
    await db
      .insert(sources)
      .values(values)
      .onConflictDoUpdate({ target: sources.key, set: values });
  }
}
