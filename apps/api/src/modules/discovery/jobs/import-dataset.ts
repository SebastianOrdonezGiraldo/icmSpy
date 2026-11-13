import { type DbExecutor, searchRunResults, sources, withTransaction } from "@icmspy/db";
import type { JobPayloads, SearchRunSourceStats, SearchRunStats } from "@icmspy/shared";
import { countDistinct, eq, sql } from "drizzle-orm";
import type pg from "pg";
import type { JobAttemptInfo } from "../../../lib/queue";
import { type IngestItem, ingestRecords } from "../../companies/ingest";
import { sourcesOf } from "../../search-runs/presets";
import {
  completeRun,
  failAttempt,
  loadRun,
  lockRun,
  reportProgress,
  startAttempt,
} from "../../search-runs/service";
import { SourceError, SourceQueryError } from "../errors";
import type { ResolvedRecord, SearchQuery, SourceAdapter } from "../ports/source-adapter";

export interface ImportDatasetDeps {
  db: DbExecutor;
  pool: pg.Pool;
  getAdapter(key: string): SourceAdapter;
}

/** Mensaje apto para el usuario: los errores de fuente se explican, el resto no se expone. */
function publicMessage(err: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "La búsqueda superó el tiempo máximo permitido";
  if (err instanceof SourceError) return err.message;
  return "Error interno al procesar la búsqueda";
}

/**
 * Otro intento del mismo job tomó la ejecución (por ejemplo, pg-boss dio este
 * por vencido y lo reintentó). Este intento no debe escribir ni marcarla.
 */
export class SupersededAttemptError extends Error {
  constructor(runId: string, attempt: number) {
    super(`El intento ${attempt} de la búsqueda ${runId} fue reemplazado por otro`);
    this.name = "SupersededAttemptError";
  }
}

/**
 * Ejecuta una búsqueda: lee la fuente completa, valida cada registro y, en
 * UNA transacción, incorpora los datos y cierra la ejecución como terminada.
 * O se confirman ambos o ninguno: si algo falla, no queda nada a medias y la
 * ejecución se marca como fallida (o pendiente de reintento).
 *
 * Una ejecución ya terminada nunca se reabre: si pg-boss vuelve a entregar el
 * job (por ejemplo, el worker cayó justo después del commit), se conserva el
 * resultado confirmado.
 */
export function createImportDatasetHandler(deps: ImportDatasetDeps) {
  return async (data: JobPayloads["import.dataset"], job: JobAttemptInfo) => {
    const run = await loadRun(deps.db, data.searchRunId);
    if (!run) throw new Error(`La búsqueda ${data.searchRunId} no existe`);
    // Entrega repetida de un job ya resuelto: no se vuelve a importar.
    if (run.status === "done") return;
    if (run.status === "failed") throw new Error(`La búsqueda ${run.id} ya terminó con error`);

    const attempt = job.retryCount + 1;
    const stats: SearchRunStats = {
      attempt,
      maxAttempts: job.retryLimit + 1,
      phase: "fetching",
      recordsRead: 0,
      pagesRead: 0,
      recordsExcluded: 0,
    };
    const started = await startAttempt(deps.db, run.id, stats);
    if (started === "superseded") {
      // Ya corre (o corrió) un intento posterior: este llegó tarde y no toca nada.
      console.warn(`[import.dataset] ${new SupersededAttemptError(run.id, attempt).message}`);
      return;
    }
    if (started === "closed") {
      // Se cerró entre la lectura y el UPDATE.
      const current = await loadRun(deps.db, run.id);
      if (current?.status === "done") return;
      throw new Error(`La búsqueda ${run.id} ya terminó con error`);
    }

    try {
      const query = run.query as SearchQuery;
      // 1. Leer cada fuente completa. Nada se escribe todavía.
      const fetched: { adapter: SourceAdapter; sourceId: string; items: IngestItem[] }[] = [];
      const perSource: SearchRunSourceStats[] = [];
      stats.sources = perSource;
      stats.recordsNotMatching = 0;
      for (const key of sourcesOf(run.query, data.adapter)) {
        const adapter = deps.getAdapter(key);
        if (!adapter.operational || !adapter.discover || !adapter.resolve) {
          throw new SourceQueryError(`La fuente ${adapter.name} no admite búsquedas automáticas`);
        }
        const [source] = await deps.db
          .select({ id: sources.id })
          .from(sources)
          .where(eq(sources.key, adapter.key));
        if (!source) throw new Error(`La fuente ${adapter.key} no está en el catálogo`);

        const resolve = adapter.resolve.bind(adapter);
        const cutoffs: ResolvedRecord[] = [];
        const own: SearchRunSourceStats = { key: adapter.key, name: adapter.name, recordsRead: 0 };
        perSource.push(own);
        const readBefore = stats.recordsRead ?? 0;
        const pagesBefore = stats.pagesRead ?? 0;
        const items: IngestItem[] = [];
        for await (const raw of adapter.discover(query, {
          signal: job.signal,
          onSnapshot: async (s) => {
            own.recordsExpected = s.expectedCount;
            own.sourceUpdatedAt = s.updatedAt?.toISOString() ?? null;
            own.sourceUrl = s.pageUrl;
            stats.recordsExpected = (stats.recordsExpected ?? 0) + s.expectedCount;
            await reportProgress(deps.db, run.id, stats);
          },
          onPage: async (p) => {
            own.recordsRead = p.recordsRead;
            stats.recordsRead = readBefore + p.recordsRead;
            stats.pagesRead = pagesBefore + p.pagesRead;
            await reportProgress(deps.db, run.id, stats);
          },
          onExcluded: () => {
            stats.recordsExcluded = (stats.recordsExcluded ?? 0) + 1;
          },
          onNotMatching: (raw) => {
            stats.recordsNotMatching = (stats.recordsNotMatching ?? 0) + 1;
            // No es resultado, pero su fecha de corte sí describe la fuente consultada.
            cutoffs.push(resolve(raw));
          },
        })) {
          items.push({ raw, resolved: resolve(raw) });
        }
        own.recordsMatched = items.length;
        // Fecha de corte: la más reciente declarada por los registros leídos, coincidan o no.
        const latest = [...items.map((i) => i.resolved), ...cutoffs]
          .filter((r) => r.sourceCutoffRaw)
          .sort(
            (a, b) => (b.sourceCutoffAt?.getTime() ?? 0) - (a.sourceCutoffAt?.getTime() ?? 0),
          )[0];
        own.sourceCutoffAt = latest?.sourceCutoffAt?.toISOString() ?? null;
        own.sourceCutoffRaw = latest?.sourceCutoffRaw ?? null;
        fetched.push({ adapter, sourceId: source.id, items });
      }
      stats.recordsMatched = fetched.reduce((n, f) => n + f.items.length, 0);
      // Con una sola fuente, sus fechas quedan también a nivel de la ejecución.
      const only = perSource.length === 1 ? perSource[0] : undefined;
      stats.sourceCutoffAt = only?.sourceCutoffAt ?? null;
      stats.sourceCutoffRaw = only?.sourceCutoffRaw ?? null;
      stats.sourceUpdatedAt = only?.sourceUpdatedAt ?? null;
      if (only?.sourceUrl) stats.sourceUrl = only.sourceUrl;
      stats.phase = "saving";
      await reportProgress(deps.db, run.id, stats);

      // 2. Incorporar todas las fuentes y cerrar la ejecución en UNA transacción:
      //    o se confirman los datos de todas las fuentes y el resultado, o nada.
      await withTransaction(deps.pool, async (tx) => {
        // Una importación por fuente a la vez, aunque haya varios workers (orden fijo: sin interbloqueos).
        for (const key of fetched.map((f) => f.adapter.key).sort()) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`import:${key}`}))`);
        }
        const current = await lockRun(tx, run.id);
        // Otro intento ya la confirmó: se conserva ese resultado y no se escribe nada.
        if (current?.status === "done") return;
        if (
          current?.status !== "running" ||
          (current.stats as SearchRunStats).attempt !== attempt
        ) {
          throw new SupersededAttemptError(run.id, attempt);
        }
        const totals: Record<string, number> = {};
        for (const f of fetched) {
          const result = await ingestRecords(tx, {
            sourceId: f.sourceId,
            searchRunId: run.id,
            items: f.items,
          });
          for (const [k, v] of Object.entries(result)) totals[k] = (totals[k] ?? 0) + v;
        }
        // Empresas y sedes encontradas: distintas, aunque las aporten varias fuentes.
        const [matched] = await tx
          .select({
            companies: countDistinct(searchRunResults.companyId),
            sites: countDistinct(searchRunResults.siteId),
          })
          .from(searchRunResults)
          .where(eq(searchRunResults.searchRunId, run.id));
        const companiesNew = totals.companiesNew ?? 0;
        const { phase: _phase, ...finalStats } = stats;
        await completeRun(tx, run.id, {
          stats: {
            ...finalStats,
            ...totals,
            companiesMatched: matched?.companies ?? 0,
            companiesExisting: (matched?.companies ?? 0) - companiesNew,
            sitesMatched: matched?.sites ?? 0,
          },
          foundCount: stats.recordsRead ?? 0,
          newCount: companiesNew,
        });
      });
    } catch (err) {
      if (err instanceof SupersededAttemptError) {
        // El intento vigente decide el estado; este no lo toca.
        console.warn(`[import.dataset] ${err.message}`);
        return;
      }
      if (!(err instanceof SourceError)) console.error(`[import.dataset] run=${run.id}`, err);
      const retryable = !(err instanceof SourceError) || err.retryable;
      const final = !retryable || job.retryCount >= job.retryLimit;
      await failAttempt(deps.db, run.id, {
        message: publicMessage(err, job.signal),
        final,
        stats,
      });
      throw err;
    }
  };
}
