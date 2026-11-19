/**
 * Demo local de la recolección de Instagram con datos de prueba.
 *
 * Todo es sintético: cuentas, seguidores y perfiles salen de `SyntheticInstagramProvider`
 * (dominio reservado `.example`, teléfonos de la serie 555). El worker consulta el perfil de cada
 * seguidor público seleccionado y guarda sus contactos en PostgreSQL; los privados no se
 * consultan. Solo se habilita con INSTAGRAM_PROVIDER=fake fuera de producción.
 */
import { selectedFollowers } from "./collect";
import { estimateCalls } from "./estimate";
import type { Outcome, Run, StopReason, StoredFollower } from "./types";

/** Seguidores a analizar en la demo y presupuesto (estimación + una llamada de margen). */
export const DEMO_REQUESTED = 50;
export const DEMO_BUDGET =
  estimateCalls({ requested: DEMO_REQUESTED, enrichProfiles: true }).total + 1;

export const DEMO_EXAMPLES = [
  {
    label: "Con contactos ficticios",
    profileUrl: "https://www.instagram.com/demo_clinica_aurora/",
  },
  {
    label: "Sin contacto publicado",
    profileUrl: "https://www.instagram.com/demo_taller_sin_contacto/",
  },
] as const;

const RESERVED_PATHS = new Set(["p", "reel", "reels", "explore", "stories", "accounts", "tv"]);

/**
 * Usuario de Instagram a partir de la URL de un perfil (o de `@usuario`). Devuelve null si no
 * es un perfil válido.
 */
export function parseInstagramProfileUrl(input: string): string | null {
  const text = input.trim();
  let candidate: string | undefined;
  if (/^@?[A-Za-z0-9._]{1,30}$/.test(text)) {
    candidate = text.replace(/^@/, "");
  } else {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "instagram.com" && host !== "www.instagram.com") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return null;
    candidate = segments[0];
  }
  if (!candidate || !/^[A-Za-z0-9._]{1,30}$/.test(candidate)) return null;
  const username = candidate.toLowerCase();
  if (RESERVED_PATHS.has(username)) return null;
  return username;
}

const STOP_TEXT: Record<StopReason, string> = {
  target_reached: "Se alcanzó el número de seguidores pedido",
  source_limited: "La fuente limitó la lista de seguidores",
  list_exhausted: "La cuenta no tiene más seguidores",
  target_private: "La cuenta es privada",
  budget_exhausted: "Se agotó el presupuesto de llamadas",
  cursor_repeated: "La fuente repitió la paginación",
  cursor_cycle: "La fuente entró en un ciclo de paginación",
  provider_error: "La fuente devolvió un error",
};

export type DemoEnrichment =
  | "con_contacto"
  | "sin_contacto"
  | "privado"
  | "pendiente"
  | "no_encontrado";

export interface DemoRow {
  position: number;
  username: string;
  profileUrl: string;
  isPrivate: boolean;
  enrichment: DemoEnrichment;
  email: string | null;
  emailSource: "button" | "biography" | null;
  phone: string | null;
  phoneSource: "button" | "biography" | null;
}

export interface DemoResult {
  runId: string;
  username: string;
  profileUrl: string;
  status: "queued" | "running" | "done";
  stopReason: StopReason | null;
  stopText: string | null;
  detail: string | null;
  progress: {
    collected: number;
    requested: number;
    profilesDone: number;
    profilesToQuery: number;
    attempts: number;
    budget: number;
  };
  summary: {
    rows: number;
    privateSkipped: number;
    withEmail: number;
    withPhone: number;
    withoutContact: number;
    pending: number;
    notFound: number;
  };
  rows: DemoRow[];
}

const ENRICHMENT: Record<StoredFollower["enrichment"], DemoEnrichment> = {
  pending: "pendiente",
  private: "privado",
  not_found: "no_encontrado",
  done: "sin_contacto",
};

/** Resultado de una ejecución para la pantalla de la demo (también mientras avanza). */
export function buildDemoResult(run: Run): DemoResult {
  const outcome: Outcome | null = run.outcome;
  const status: DemoResult["status"] = outcome
    ? "done"
    : run.attempts.length === 0
      ? "queued"
      : "running";
  const selected = selectedFollowers(run);
  const rows: DemoRow[] = selected.map((f) => {
    const email = f.contacts.find((c) => c.kind === "email") ?? null;
    const phone = f.contacts.find((c) => c.kind === "phone") ?? null;
    const enrichment: DemoEnrichment =
      f.enrichment === "done" && (email || phone) ? "con_contacto" : ENRICHMENT[f.enrichment];
    return {
      position: f.order,
      username: f.username,
      profileUrl: `https://www.instagram.com/${f.username}/`,
      isPrivate: f.isPrivate,
      enrichment,
      email: email?.value ?? null,
      emailSource: email?.source ?? null,
      phone: phone?.original ?? null,
      phoneSource: phone?.source ?? null,
    };
  });
  const count = (e: DemoEnrichment) => rows.filter((r) => r.enrichment === e).length;
  const queried = selected.filter((f) => f.enrichment === "done" || f.enrichment === "not_found");
  return {
    runId: run.id,
    username: run.username,
    profileUrl: `https://www.instagram.com/${run.username}/`,
    status,
    stopReason: outcome?.stopReason ?? null,
    stopText: outcome ? STOP_TEXT[outcome.stopReason] : null,
    detail: outcome?.detail ?? null,
    progress: {
      collected: Math.min(run.followers.length, run.requested),
      requested: run.requested,
      profilesDone: queried.length,
      profilesToQuery: queried.length + count("pendiente"),
      attempts: run.attempts.length,
      budget: run.budgetMaxCalls,
    },
    summary: {
      rows: rows.length,
      privateSkipped: count("privado"),
      withEmail: rows.filter((r) => r.email).length,
      withPhone: rows.filter((r) => r.phone).length,
      withoutContact: count("sin_contacto"),
      pending: count("pendiente"),
      notFound: count("no_encontrado"),
    },
    rows,
  };
}
