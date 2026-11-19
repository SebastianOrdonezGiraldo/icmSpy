/**
 * Demo local de la recolección de Instagram con datos de prueba.
 *
 * Todo es sintético: las cuentas y seguidores salen de `SyntheticInstagramProvider` y los
 * contactos comerciales de `syntheticBusinessContact`, un directorio inventado y determinista
 * (dominio reservado `.example`, teléfonos de la serie 555). Los seguidores privados no se
 * enriquecen. Solo se habilita con INSTAGRAM_PROVIDER=fake fuera de producción.
 */
import { selectedFollowers } from "./collect";
import { estimateCalls } from "./estimate";
import type { Outcome, Run, StopReason } from "./types";

/** Seguidores a analizar en la demo y presupuesto (estimación + una llamada de margen). */
export const DEMO_REQUESTED = 50;
export const DEMO_BUDGET = estimateCalls({ requested: DEMO_REQUESTED }).total + 1;

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

export interface DemoContact {
  email: string | null;
  phone: string | null;
}

/**
 * Directorio de contactos comerciales FICTICIOS de la demo. Para una cuenta cuyo usuario
 * contiene "sin_contacto", ningún seguidor publica contacto. En las demás, por posición:
 * 1 de cada 3 publica correo y teléfono, 1 de cada 3 solo correo y el resto nada.
 */
export function syntheticBusinessContact(targetUsername: string, position: number): DemoContact {
  if (targetUsername.includes("sin_contacto")) return { email: null, phone: null };
  const kind = position % 3;
  const email = kind === 0 ? null : `contacto${position}@negocio-demo.example`;
  const phone = kind === 1 ? `+57 601 555 ${String(position).padStart(4, "0")}` : null;
  return { email, phone };
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

export type DemoEnrichment = "con_contacto" | "sin_contacto" | "privado";

export interface DemoRow {
  position: number;
  username: string;
  profileUrl: string;
  isPrivate: boolean;
  enrichment: DemoEnrichment;
  email: string | null;
  phone: string | null;
}

export interface DemoResult {
  runId: string;
  username: string;
  profileUrl: string;
  status: "queued" | "running" | "done";
  stopReason: StopReason | null;
  stopText: string | null;
  detail: string | null;
  progress: { collected: number; requested: number; attempts: number; budget: number };
  summary: {
    rows: number;
    privateSkipped: number;
    withEmail: number;
    withPhone: number;
    withoutContact: number;
  };
  rows: DemoRow[];
}

/** Resultado de una ejecución para la pantalla de la demo (también mientras avanza). */
export function buildDemoResult(run: Run): DemoResult {
  const outcome: Outcome | null = run.outcome;
  const status: DemoResult["status"] = outcome
    ? "done"
    : run.attempts.length === 0
      ? "queued"
      : "running";
  const rows: DemoRow[] = selectedFollowers(run).map((f) => {
    const base = {
      position: f.order,
      username: f.username,
      profileUrl: `https://www.instagram.com/${f.username}/`,
      isPrivate: f.isPrivate,
    };
    if (f.isPrivate) return { ...base, enrichment: "privado", email: null, phone: null };
    const contact = syntheticBusinessContact(run.username, f.order);
    const has = contact.email !== null || contact.phone !== null;
    return { ...base, enrichment: has ? "con_contacto" : "sin_contacto", ...contact };
  });
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
      attempts: run.attempts.length,
      budget: run.budgetMaxCalls,
    },
    summary: {
      rows: rows.length,
      privateSkipped: rows.filter((r) => r.enrichment === "privado").length,
      withEmail: rows.filter((r) => r.email).length,
      withPhone: rows.filter((r) => r.phone).length,
      withoutContact: rows.filter((r) => r.enrichment === "sin_contacto").length,
    },
    rows,
  };
}
