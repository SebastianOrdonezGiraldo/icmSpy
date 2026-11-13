const ROLE_LOCAL_PARTS = new Set([
  "info",
  "contacto",
  "contactenos",
  "ventas",
  "comercial",
  "compras",
  "gerencia",
  "administracion",
  "admin",
  "servicioalcliente",
  "atencionalcliente",
  "pqrs",
  "recepcion",
  "facturacion",
  "cartera",
  "notificaciones",
  "notificacionesjudiciales",
]);

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

/** true si es un buzón de la empresa (info@, ventas@) y no de una persona. */
export function isRoleAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return ROLE_LOCAL_PARTS.has(local.replace(/[._-]/g, ""));
}

export interface PhoneOptions {
  /**
   * Indicativo regional (un dígito, p. ej. "6" para el Eje Cafetero) con el
   * que se marcaban los fijos de 7 dígitos antes del plan de marcación de
   * 2021. Solo se usa si se conoce el departamento del número; sin él, un
   * fijo de 7 dígitos se descarta.
   */
  landlineArea?: string;
}

/**
 * Códigos de operador de larga distancia nacional que se marcaban antes del
 * indicativo regional hasta 2021 ("0" + operador + indicativo + número). La
 * CRC los eliminó con la marcación única nacional (comunicado del 24-ago-2021:
 * "5 para UNE, 7 para ETB, 9 para Telefónica, 456 para Claro"). Solo se
 * incluye el que aparece en los datos importados; ver docs/fuentes/reps.md.
 */
const LEGACY_LONG_DISTANCE_CARRIERS = new Set(["9"]);

/**
 * Teléfono colombiano a formato E.164 (+57...). Devuelve null si no es válido.
 *
 * Acepta el formato vigente (celular 3XX o fijo 60X, 10 dígitos) y fijos
 * escritos con el formato anterior al plan de marcación de 2021
 * (indicativo de un dígito + 7 dígitos, que hoy se marcan 60 + indicativo + 7).
 */
export function normalizePhoneCO(value: string, options: PhoneOptions = {}): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length === 12) digits = digits.slice(2);
  // Celulares (3XX) y fijos con indicativo (60X), ambos de 10 dígitos.
  if (/^(3\d{9}|60\d{8})$/.test(digits)) return `+57${digits}`;
  // Formato anterior con el indicativo escrito: "(6) 7451234", "06 7451234", "57 6 7451234".
  const legacy = /^(?:57|0)?([1-8])(\d{7})$/.exec(digits);
  if (legacy) return `+5760${legacy[1]}${legacy[2]}`;
  const area = options.landlineArea;
  const knownArea = area && /^[1-8]$/.test(area) ? area : undefined;
  if (knownArea && /^[2-8]\d{6}$/.test(digits)) return `+5760${knownArea}${digits}`;
  // Larga distancia anterior a 2021 con código de operador: "(096) 7451234",
  // "96 7451234" = [0] + operador 9 + indicativo 6 + número de 7 dígitos.
  // Solo si el indicativo escrito coincide con el de la ubicación del dato:
  // así el valor y el contexto de la fuente dicen lo mismo.
  const carrier = /^0?(\d)([1-8])([2-8]\d{6})$/.exec(digits);
  if (
    carrier &&
    knownArea &&
    LEGACY_LONG_DISTANCE_CARRIERS.has(carrier[1] as string) &&
    carrier[2] === knownArea
  ) {
    return `+5760${carrier[2]}${carrier[3]}`;
  }
  return null;
}

/** Etiquetas que solo anuncian un teléfono: separan contactos y no forman parte del número. */
const PHONE_LABELS = /(?:^|\s)(?:tel[eé]fonos?|tel|fijo|cel(?:ular)?|m[oó]vil)\.?:?(?=\s|\d|$)/gi;

export interface ParsedContactValue {
  /** Fragmento tal como aparece en la fuente. */
  raw: string;
  /** Valor normalizado, o null si no se pudo interpretar. */
  normalized: string | null;
}

/**
 * Separa un campo de texto libre con uno o varios teléfonos
 * ("7451234 - 3105551234", "745 12 34 Ext. 101", ...).
 */
export function parsePhonesCO(text: string, options: PhoneOptions = {}): ParsedContactValue[] {
  const out: ParsedContactValue[] = [];
  const segments = text
    .replace(PHONE_LABELS, "|")
    .split(/[,;/|]|\s+-\s+|\s+[yYoO]\s+|\s{2,}/)
    // Un separador que quedó colgando (p. ej. "3105551234 -" junto a una etiqueta) no es parte del número.
    .map((s) => s.trim().replace(/^[-–]+\s*|\s*[-–]+$/g, ""))
    .filter(Boolean);
  for (const segment of segments) {
    // La extensión se ignora para normalizar; el valor original la conserva.
    const base = segment.replace(/\s*(?:ext|extensi[oó]n)(?![a-z]).*$/i, "").trim();
    if (!/\d/.test(base)) continue;
    const whole = normalizePhoneCO(base, options);
    if (whole) {
      out.push({ raw: segment, normalized: whole });
      continue;
    }
    // Varios números unidos por un espacio o un guion: "7451234 3105551234",
    // "745-12-34 3105551234", "3105551234-3125551234". Se prueba primero el
    // espacio (así un fijo escrito con guiones queda entero) y luego el guion.
    // Solo se separa si cada parte tiene al menos 7 dígitos.
    const parts = [/\s+/, /-+/, /[\s-]+/]
      .map((separator) =>
        base
          .split(separator)
          .map((p) => p.replace(/^-+|-+$/g, "").trim())
          .filter(Boolean),
      )
      .find((p) => p.length > 1 && p.every((part) => part.replace(/\D/g, "").length >= 7));
    if (parts) {
      for (const part of parts)
        out.push({ raw: part, normalized: normalizePhoneCO(part, options) });
      continue;
    }
    out.push({ raw: segment, normalized: null });
  }
  return out;
}

/** Separa un campo de texto libre con uno o varios correos. */
export function parseEmails(text: string): ParsedContactValue[] {
  return text
    .split(/[\s,;/|]+/)
    .map((s) => s.trim().replace(/^[<(]+|[>).]+$/g, ""))
    .filter(Boolean)
    .map((raw) => ({ raw, normalized: normalizeEmail(raw) }));
}

/** NIT sin puntos, espacios ni dígito de verificación. */
export function normalizeNit(value: string): string | null {
  const base = value.trim().split("-")[0]?.replace(/\D/g, "") ?? "";
  return base.length >= 6 && base.length <= 10 ? base : null;
}

export function normalizeDomain(value: string): string | null {
  try {
    const url = new URL(
      /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`,
    );
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}
