import { createHash } from "node:crypto";
import { type Db, type DbExecutor, suppressionList } from "@icmspy/db";
import { and, eq, inArray } from "drizzle-orm";

type SuppressionKind = (typeof suppressionList.$inferInsert)["kind"];

/** La lista de supresión guarda solo el hash, nunca el dato. */
export function hashValue(normalizedValue: string): string {
  return createHash("sha256").update(normalizedValue).digest("hex");
}

export async function isSuppressed(db: Db, kind: SuppressionKind, normalizedValue: string) {
  const [row] = await db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.kind, kind),
        eq(suppressionList.valueHash, hashValue(normalizedValue)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function suppress(
  db: Db,
  kind: SuppressionKind,
  normalizedValue: string,
  reason: string,
) {
  await db
    .insert(suppressionList)
    .values({ kind, valueHash: hashValue(normalizedValue), reason })
    .onConflictDoNothing();
}

export interface SuppressionCandidate {
  kind: SuppressionKind;
  normalizedValue: string;
}

/**
 * Devuelve las claves `kind:valor` suprimidas entre los candidatos, en una
 * sola consulta. Para correos se revisa también el dominio.
 */
export async function findSuppressed(
  db: DbExecutor,
  candidates: SuppressionCandidate[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const byHash = new Map<string, string[]>();
  for (const c of candidates) {
    const key = `${c.kind}:${c.normalizedValue}`;
    const hash = hashValue(c.normalizedValue);
    byHash.set(hash, [...(byHash.get(hash) ?? []), key]);
  }
  const rows = await db
    .select({ kind: suppressionList.kind, valueHash: suppressionList.valueHash })
    .from(suppressionList)
    .where(inArray(suppressionList.valueHash, [...byHash.keys()]));
  const hit = new Set<string>();
  for (const row of rows) {
    for (const key of byHash.get(row.valueHash) ?? []) {
      if (key.startsWith(`${row.kind}:`)) hit.add(key);
    }
  }
  return hit;
}
