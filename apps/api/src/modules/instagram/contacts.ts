/**
 * Extracción de contactos del perfil público de un seguidor: botones de contacto comerciales y
 * biografía. Nada se infiere ni se completa: solo se normaliza lo que aparece escrito.
 */
import type { FollowerContact, FollowerProfile } from "./types";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Secuencias con aspecto de teléfono: dígitos con espacios, puntos, guiones o paréntesis. */
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;

export function normalizeEmail(raw: string): string | null {
  const m = raw.trim().match(new RegExp(`^${EMAIL.source}$`));
  return m ? raw.trim().toLowerCase() : null;
}

/**
 * Teléfono normalizado: dígitos, con + si es internacional. Un número colombiano escrito sin
 * prefijo (celular de 10 dígitos que empieza por 3, o fijo 60X de 10 dígitos) recibe +57.
 * Fuera de 7 a 15 dígitos no se considera teléfono.
 */
export function normalizePhone(raw: string): string | null {
  const text = raw.trim();
  const digits = text.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (text.startsWith("+")) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith("57")) return `+${digits}`;
  if (digits.length === 10 && (digits.startsWith("3") || digits.startsWith("60"))) {
    return `+57${digits}`;
  }
  return digits;
}

/** Contactos de un perfil, sin duplicados (prevalece el botón) y ordenados por tipo y valor. */
export function extractContacts(profile: FollowerProfile): FollowerContact[] {
  if (profile.status !== "ok" || profile.isPrivate) return [];
  const found = new Map<string, FollowerContact>();
  const add = (c: FollowerContact) => {
    const key = `${c.kind}:${c.value}`;
    const prev = found.get(key);
    if (!prev || (prev.source === "biography" && c.source === "button")) found.set(key, c);
  };

  if (profile.businessEmail) {
    const value = normalizeEmail(profile.businessEmail);
    if (value) add({ kind: "email", value, original: profile.businessEmail, source: "button" });
  }
  if (profile.businessPhone) {
    const value = normalizePhone(profile.businessPhone);
    if (value) add({ kind: "phone", value, original: profile.businessPhone, source: "button" });
  }
  const bio = profile.biography ?? "";
  for (const m of bio.matchAll(EMAIL)) {
    add({ kind: "email", value: m[0].toLowerCase(), original: m[0], source: "biography" });
  }
  // Los teléfonos se buscan en la biografía sin los correos, para no leer dígitos de ellos.
  for (const m of bio.replace(EMAIL, " ").matchAll(PHONE)) {
    const value = normalizePhone(m[0]);
    if (value) add({ kind: "phone", value, original: m[0].trim(), source: "biography" });
  }
  return [...found.values()].sort((a, b) =>
    a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind.localeCompare(b.kind),
  );
}
