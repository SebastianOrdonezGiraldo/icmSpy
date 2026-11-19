import {
  companies,
  type DbExecutor,
  searchRunMatches,
  searchRunResults,
  siteServices,
  sources,
  withTransaction,
} from "@icmspy/db";
import {
  type JobPayloads,
  matchesKeyword,
  type SearchRunSourceStats,
  type SearchRunStats,
} from "@icmspy/shared";
import { and, countDistinct, eq, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import type { JobAttemptInfo } from "../../../lib/queue";
import {
  type IngestItem,
  type IngestLink,
  ingestRecords,
  saveSourceRecord,
} from "../../companies/ingest";
import { queryVersion, type StoredSearchQuery, sourcesOf } from "../../search-runs/presets";
import {
  completeRun,
  failAttempt,
  loadRun,
  lockRun,
  reportProgress,
  startAttempt,
} from "../../search-runs/service";
import { SourceError, SourceQueryError } from "../errors";
import type {
  RawRecord,
  ResolvedRecord,
  ResolvedServiceRecord,
  SearchQuery,
  SourceAdapter,
} from "../ports/source-adapter";

/** Relación sede → servicio leída de una fuente de servicios. */
interface Evidence {
  adapter: SourceAdapter;
  sourceId: string;
  raw: RawRecord;
  service: ResolvedServiceRecord;
}

/** Sede del lugar leída de la fuente de prestadores, con sus evidencias. */
interface Candidate {
  adapter: SourceAdapter;
  sourceId: string;
  item: IngestItem;
  nameMatch: boolean;
  services: Evidence[];
}

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
      const version = queryVersion(run.query);
      const query = run.query as SearchQuery & Partial<StoredSearchQuery>;
      const keys = sourcesOf(run.query, data.adapter);
      const adaptersByKey = keys.map((key) => deps.getAdapter(key));
      const providerAdapters = adaptersByKey.filter((a) => (a.role ?? "providers") === "providers");
      const serviceAdapters = adaptersByKey.filter((a) => a.role === "services");
      const terms = query.keywords ?? [];
      const serviceKind = new Map((query.services ?? []).map((s) => [s.code, s.kind]));
      const sourceIdOf = async (key: string) => {
        const [source] = await deps.db
          .select({ id: sources.id })
          .from(sources)
          .where(eq(sources.key, key));
        if (!source) throw new Error(`La fuente ${key} no está en el catálogo`);
        return source.id;
      };

      // 1. Prestadores y sedes del lugar (fuente de identidad y contactos). Nada se escribe todavía.
      //    En v3 se leen todas las sedes del lugar: el nombre y el servicio se evalúan después.
      const perSource: SearchRunSourceStats[] = [];
      stats.sources = perSource;
      stats.recordsNotMatching = 0;
      const candidates = new Map<string, Candidate>();
      const fetched: { adapter: SourceAdapter; sourceId: string; items: IngestItem[] }[] = [];
      for (const adapter of providerAdapters) {
        if (!adapter.operational || !adapter.discover || !adapter.resolve) {
          throw new SourceQueryError(`La fuente ${adapter.name} no admite búsquedas automáticas`);
        }
        const sourceId = await sourceIdOf(adapter.key);
        const resolve = adapter.resolve.bind(adapter);
        const cutoffs: ResolvedRecord[] = [];
        const own: SearchRunSourceStats = {
          key: adapter.key,
          name: adapter.name,
          role: "providers",
          status: "ok",
          recordsRead: 0,
        };
        perSource.push(own);
        const readBefore = stats.recordsRead ?? 0;
        const pagesBefore = stats.pagesRead ?? 0;
        const items: IngestItem[] = [];
        const providerQuery = version === 3 ? { ...query, keywords: undefined } : query;
        for await (const raw of adapter.discover(providerQuery, {
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
          const resolved = resolve(raw);
          if (version === 3) {
            const siteCode = resolved.site?.externalId ?? raw.externalId;
            candidates.set(siteCode, {
              adapter,
              sourceId,
              item: { raw, resolved },
              nameMatch: matchesKeyword(terms, [resolved.company.legalName, resolved.site?.name]),
              services: [],
            });
          } else {
            items.push({ raw, resolved });
          }
        }
        const read = version === 3 ? [...candidates.values()].map((c) => c.item.resolved) : [];
        const latest = [...items.map((i) => i.resolved), ...cutoffs, ...read]
          .filter((r) => r.sourceCutoffRaw)
          .sort(
            (a, b) => (b.sourceCutoffAt?.getTime() ?? 0) - (a.sourceCutoffAt?.getTime() ?? 0),
          )[0];
        own.sourceCutoffAt = latest?.sourceCutoffAt?.toISOString() ?? null;
        own.sourceCutoffRaw = latest?.sourceCutoffRaw ?? null;
        if (version !== 3) {
          own.recordsMatched = items.length;
          fetched.push({ adapter, sourceId, items });
        }
      }

      // 2. Servicios (v3): relación oficial sede → servicio, cruzada por código de sede.
      const evidences: Evidence[] = [];
      if (version === 3) {
        if ((query.services ?? []).length > 0 && serviceAdapters.length === 0) {
          stats.noServiceSourceForLocation = true;
        }
        for (const adapter of serviceAdapters) {
          const own: SearchRunSourceStats = {
            key: adapter.key,
            name: adapter.name,
            role: "services",
            status: "ok",
            recordsRead: 0,
            serviceRelations: 0,
          };
          perSource.push(own);
          const found: Evidence[] = [];
          try {
            if (!adapter.operational || !adapter.discover || !adapter.resolveService) {
              throw new SourceQueryError(`La fuente ${adapter.name} no publica servicios`);
            }
            const sourceId = await sourceIdOf(adapter.key);
            const resolveService = adapter.resolveService.bind(adapter);
            for await (const raw of adapter.discover(query, {
              signal: job.signal,
              onSnapshot: async (s) => {
                own.recordsExpected = s.expectedCount;
                own.sourceUpdatedAt = s.updatedAt?.toISOString() ?? null;
                own.sourceUrl = s.pageUrl;
                await reportProgress(deps.db, run.id, stats);
              },
              onPage: async (p) => {
                own.recordsRead = p.recordsRead;
                await reportProgress(deps.db, run.id, stats);
              },
            })) {
              found.push({ adapter, sourceId, raw, service: resolveService(raw) });
            }
          } catch (err) {
            // Fuente de servicios caída: se reintenta toda la búsqueda mientras queden
            // intentos; en el último, se sigue sin ella y el resultado queda como parcial.
            const retryable = !(err instanceof SourceError) || err.retryable;
            if (retryable && job.retryCount < job.retryLimit) throw err;
            own.status = "failed";
            own.error = publicMessage(err, job.signal);
            stats.partial = true;
            continue;
          }
          own.serviceRelations = found.length;
          const latest = found
            .map((e) => e.service)
            .filter((s) => s.sourceCutoffAt)
            .sort(
              (a, b) => (b.sourceCutoffAt?.getTime() ?? 0) - (a.sourceCutoffAt?.getTime() ?? 0),
            )[0];
          own.sourceCutoffAt = latest?.sourceCutoffAt?.toISOString() ?? null;
          own.sourceCutoffRaw = latest?.sourceCutoffRaw ?? null;
          // Cruce: la evidencia solo se usa si la sede existe hoy en REPS y está en el lugar.
          const missing = new Set<string>();
          const withService = new Set<string>();
          for (const e of found) {
            // Solo servicios pedidos: una fila con otro código no es evidencia de esta búsqueda.
            if (!serviceKind.has(e.service.serviceCode)) {
              stats.recordsExcluded = (stats.recordsExcluded ?? 0) + 1;
              continue;
            }
            const candidate = candidates.get(e.service.siteCode);
            if (candidate) {
              candidate.services.push(e);
              withService.add(e.service.siteCode);
              evidences.push(e);
            } else {
              missing.add(e.service.siteCode);
            }
          }
          own.sitesWithService = withService.size;
          own.sitesNotInReps = 0;
          own.sitesOutsideLocation = 0;
          const provider = providerAdapters[0];
          if (missing.size > 0 && provider?.lookupSiteLocations) {
            const present = await provider.lookupSiteLocations([...missing], job.signal);
            for (const code of missing) {
              if (present.has(code)) own.sitesOutsideLocation++;
              else own.sitesNotInReps++;
            }
          } else {
            own.sitesNotInReps = missing.size;
          }
        }
        // Lo que entra: sedes con servicio (confirmado o relacionado) o con el nombre.
        const repsItems = new Map<SourceAdapter, IngestItem[]>();
        for (const c of candidates.values()) {
          if (!c.nameMatch && c.services.length === 0) continue;
          repsItems.set(c.adapter, [...(repsItems.get(c.adapter) ?? []), c.item]);
        }
        for (const adapter of providerAdapters) {
          const items = repsItems.get(adapter) ?? [];
          const own = perSource.find((p) => p.key === adapter.key);
          if (own) own.recordsMatched = items.length;
          fetched.push({ adapter, sourceId: await sourceIdOf(adapter.key), items });
        }
        stats.recordsNotMatching =
          candidates.size - fetched.reduce((n, f) => n + f.items.length, 0);
      }
      stats.recordsMatched = fetched.reduce((n, f) => n + f.items.length, 0);
      // Las fechas de la fuente de prestadores quedan también a nivel de la ejecución.
      const main = perSource.find((p) => p.role === "providers");
      stats.sourceCutoffAt = main?.sourceCutoffAt ?? null;
      stats.sourceCutoffRaw = main?.sourceCutoffRaw ?? null;
      stats.sourceUpdatedAt = main?.sourceUpdatedAt ?? null;
      if (main?.sourceUrl) stats.sourceUrl = main.sourceUrl;
      stats.phase = "saving";
      await reportProgress(deps.db, run.id, stats);

      // 3. Incorporar y cerrar la ejecución en UNA transacción: datos, evidencias y
      //    resultado se confirman juntos o nada.
      await withTransaction(deps.pool, async (tx) => {
        // Una importación por fuente a la vez, aunque haya varios workers (orden fijo: sin interbloqueos).
        for (const key of [...keys].sort()) {
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
        const links = new Map<string, IngestLink>();
        for (const f of fetched) {
          const result = await ingestRecords(tx, {
            sourceId: f.sourceId,
            searchRunId: run.id,
            items: f.items,
            onLinked: (externalId, link) => links.set(externalId, link),
          });
          for (const [k, v] of Object.entries(result)) totals[k] = (totals[k] ?? 0) + v;
        }

        if (version === 3) {
          // Coincidencias de nombre.
          for (const c of candidates.values()) {
            const link = links.get(c.item.raw.externalId);
            if (!c.nameMatch || !link) continue;
            await tx
              .insert(searchRunMatches)
              .values({
                searchRunId: run.id,
                companyId: link.companyId,
                siteId: link.siteId,
                sourceId: c.sourceId,
                sourceRecordId: link.sourceRecordId,
                matchType: "name",
              })
              .onConflictDoNothing();
          }
          // Servicios: original de la fuente de servicios, servicio de la sede y evidencia.
          for (const e of evidences) {
            const candidate = candidates.get(e.service.siteCode);
            const link = candidate && links.get(candidate.item.raw.externalId);
            if (!link?.siteId) continue;
            const record = await saveSourceRecord(tx, {
              sourceId: e.sourceId,
              searchRunId: run.id,
              raw: e.raw,
            });
            const values = {
              sourceRecordId: record.id,
              serviceName: e.service.serviceName,
              status: e.service.status,
              modalities: e.service.modalities,
              sourceUrl: e.raw.url ?? null,
              sourceCutoffAt: e.service.sourceCutoffAt,
              observedAt: sql`now()`,
            };
            await tx
              .insert(siteServices)
              .values({
                siteId: link.siteId,
                sourceId: e.sourceId,
                serviceCode: e.service.serviceCode,
                ...values,
              })
              .onConflictDoUpdate({
                target: [siteServices.siteId, siteServices.sourceId, siteServices.serviceCode],
                set: values,
                // Una observación con corte anterior no sustituye a una más reciente.
                setWhere: sql`${siteServices.sourceCutoffAt} is null or (excluded.source_cutoff_at is not null and excluded.source_cutoff_at >= ${siteServices.sourceCutoffAt})`,
              });
            const kind = serviceKind.get(e.service.serviceCode) ?? "related";
            await tx
              .insert(searchRunMatches)
              .values({
                searchRunId: run.id,
                companyId: link.companyId,
                siteId: link.siteId,
                sourceId: e.sourceId,
                sourceRecordId: record.id,
                matchType: kind === "related" ? "related" : "service",
                conceptKind: kind,
                serviceCode: e.service.serviceCode,
              })
              .onConflictDoNothing();
            // Naturaleza de la persona: solo si la fuente la declara y no se conocía.
            if (e.service.personKind) {
              await tx
                .update(companies)
                .set({ personKind: e.service.personKind })
                .where(and(eq(companies.id, link.companyId), isNull(companies.personKind)));
            }
          }
          const byType = await tx
            .select({
              type: searchRunMatches.matchType,
              n: countDistinct(searchRunMatches.companyId),
            })
            .from(searchRunMatches)
            .where(eq(searchRunMatches.searchRunId, run.id))
            .groupBy(searchRunMatches.matchType);
          stats.companiesByMatch = Object.fromEntries(byType.map((r) => [r.type, r.n]));
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
