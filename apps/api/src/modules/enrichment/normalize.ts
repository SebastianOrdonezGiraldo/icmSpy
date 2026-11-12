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

/** Teléfono colombiano a formato E.164 (+57...). Devuelve null si no es válido. */
export function normalizePhoneCO(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length === 12) digits = digits.slice(2);
  // Celulares (3XX) y fijos con indicativo (60X), ambos de 10 dígitos.
  return /^(3\d{9}|60\d{8})$/.test(digits) ? `+57${digits}` : null;
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
