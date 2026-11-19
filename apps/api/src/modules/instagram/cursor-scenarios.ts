/**
 * Escenarios de cursores para pruebas (memoria y PostgreSQL), con datos sintéticos.
 * El núcleo no debe normalizar ningún cursor: se guarda y se reenvía exactamente.
 */
import { FakeInstagramProvider, syntheticFollowers } from "./fake-provider";
import type { Cursor, FollowersPage, TargetAccount } from "./types";

export const cursorTarget: TargetAccount = {
  pk: "100000003",
  username: "cuenta_cursores_demo",
  followerCount: 1_000,
  isPrivate: false,
  isVerified: false,
};

/** Cursores válidos que deben conservarse tal cual, en orden de petición. */
export const VALID_CURSOR_CHAIN: Array<Cursor | null> = [null, "�", "😀", "", "null"];

/** Cursores que no pueden guardarse ni reenviarse exactamente. */
export const INVALID_CURSORS: Array<[label: string, cursor: string, reason: RegExp]> = [
  ["sustituto alto aislado", "a\uD800b", /sustituto UTF-16 aislado/],
  ["sustituto bajo aislado", "\uDC00", /sustituto UTF-16 aislado/],
  ["U+0000", "x\u0000y", /U\+0000/],
];

const page = (from: number, count: number, nextCursor: Cursor | null): FollowersPage => ({
  users: syntheticFollowers(from, count),
  nextCursor,
  limited: false,
});

/** Cinco páginas de 10 encadenadas por VALID_CURSOR_CHAIN; la última no ofrece continuación. */
export function validChainProvider() {
  return new FakeInstagramProvider(
    cursorTarget,
    VALID_CURSOR_CHAIN.map((cursor, i) => ({
      cursor,
      page: page(1 + i * 10, 10, VALID_CURSOR_CHAIN[i + 1] ?? null),
    })),
  );
}

export const FIRST_CURSOR = "c-25";

/** La primera página es válida (cursor FIRST_CURSOR); la segunda devuelve `bad` como cursor. */
export function invalidCursorProvider(bad: string) {
  return new FakeInstagramProvider(cursorTarget, [
    { cursor: null, page: page(1, 25, FIRST_CURSOR) },
    { cursor: FIRST_CURSOR, page: page(26, 25, bad) },
  ]);
}
