import { createHash } from "node:crypto";
import { type Db, suppressionList } from "@icmspy/db";
import { and, eq } from "drizzle-orm";

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
