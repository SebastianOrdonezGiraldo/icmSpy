const dateFmt = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" });

export function formatDate(iso: string | null | undefined) {
  return iso ? dateFmt.format(new Date(iso)) : "—";
}

export function formatDateTime(iso: string | null | undefined) {
  return iso ? dateTimeFmt.format(new Date(iso)) : "—";
}

/** "+576067329056" → "+57 606 732 9056"; "+573105551234" → "+57 310 555 1234". */
export function formatPhone(e164: string) {
  const m = /^\+57(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+57 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** Nombre legible de cada fuente. */
export const SOURCE_LABELS: Record<string, string> = {
  reps: "REPS",
  invima: "INVIMA",
  csv: "CSV",
  website: "Sitio web",
};

/** Nombre legible del campo de la fuente del que salió un dato. */
export const SOURCE_FIELD_LABELS: Record<string, string> = {
  email_sede: "correo de la sede",
  t_lefonosede: "teléfono de la sede",
  email_prestador: "correo del prestador",
  telefonoprestador: "teléfono del prestador",
};
