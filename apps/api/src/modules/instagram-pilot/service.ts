/**
 * Visor de solo lectura de las ejecuciones del piloto de Instagram (tools/instagram-pilot).
 *
 * Lee los archivos que genera el piloto en su carpeta local (summary.json, followers.jsonl,
 * contacts.jsonl). No consulta Instagram, no escribe en la base de datos y no incorpora nada a
 * companies, people ni contact_points.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Nombre de carpeta que crea el piloto: 20261117T153000Z-usuario */
export const RUN_ID_RE = /^\d{8}T\d{6}Z-[a-z0-9._]{1,30}$/;

export interface PilotRunListItem {
  runId: string;
  target: string;
  status: string;
  stopReason: string | null;
  stopReasonText: string;
  updatedAt: string | null;
  counters: Record<string, number>;
  contacts: number;
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Json;
  } catch {
    return null;
  }
}

async function readJsonl(path: string): Promise<Json[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Json[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Json);
    } catch {
      // línea incompleta: se ignora
    }
  }
  return out;
}

function listItem(runId: string, s: Json): PilotRunListItem {
  const target = (s.target as Json | undefined) ?? {};
  const contacts = (s.contacts as Json | undefined) ?? {};
  return {
    runId,
    target: String(target.username ?? ""),
    status: String(s.status ?? "desconocido"),
    stopReason: (s.stop_reason as string | null) ?? null,
    stopReasonText: String(s.stop_reason_text ?? ""),
    updatedAt: (s.updated_at as string | null) ?? null,
    counters: (s.counters as Record<string, number>) ?? {},
    contacts: Number(contacts.observations ?? 0),
  };
}

export async function listPilotRuns(root: string): Promise<PilotRunListItem[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const runs: PilotRunListItem[] = [];
  for (const runId of entries) {
    const summary = await readJson(join(root, runId, "summary.json"));
    if (summary) runs.push(listItem(runId, summary));
  }
  return runs.sort((a, b) => b.runId.localeCompare(a.runId));
}

export async function getPilotRun(root: string, runId: string) {
  if (!RUN_ID_RE.test(runId)) return null;
  const dir = join(root, runId);
  const summary = await readJson(join(dir, "summary.json"));
  if (!summary) return null;
  // Las rutas locales del equipo no se envían al navegador.
  delete summary.files;
  return {
    summary,
    followers: await readJsonl(join(dir, "followers.jsonl")),
    contacts: await readJsonl(join(dir, "contacts.jsonl")),
  };
}
