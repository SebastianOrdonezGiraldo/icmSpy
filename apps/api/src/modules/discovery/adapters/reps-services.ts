import { z } from "zod";
import {
  SourceConsistencyError,
  SourceHttpError,
  SourceQueryError,
  SourceSchemaError,
  SourceUnavailableError,
} from "../errors";
import type {
  DiscoverHooks,
  RawRecord,
  ResolvedServiceRecord,
  SearchQuery,
  SourceAdapter,
} from "../ports/source-adapter";
import { parseRepsCutoff } from "./reps";

/**
 * Servicios habilitados por sede publicados en datos.gov.co con la estructura
 * de exportación del REPS. No hay una publicación nacional abierta: cada
 * conjunto cubre un territorio y tiene su propia fecha de corte. Se cruzan con
 * el REPS nacional por código de sede (código de habilitación + número de
 * sede). Validación: docs/fuentes/servicios.md.
 */
interface ServiceDatasetConfig {
  key: string;
  name: string;
  datasetId: string;
  pageUrl: string;
  departmentCodes: string[];
  coverage: string;
  fields: {
    providerCode: string;
    siteNumber: string;
    serviceCode: string;
    serviceName: string;
    /** Estado publicado; si falta, la fuente no lo publica. */
    status?: string;
    personKind?: string;
    cutoff?: string;
  };
  /** Columnas "SI/NO" de modalidad y su etiqueta. */
  modalities: Record<string, string>;
}

const PORTAL = "https://www.datos.gov.co";
const MODALITIES = {
  ambulatorio: "ambulatorio",
  hospitalario: "hospitalario",
  unidad_movil: "unidad móvil",
  domiciliario: "domiciliario",
  otras_extramural: "otras extramurales",
};

export const SERVICE_DATASETS: readonly ServiceDatasetConfig[] = [
  {
    key: "reps-servicios-cundinamarca",
    name: "Servicios habilitados REPS – Cundinamarca (MinSalud)",
    datasetId: "j93s-yemu",
    pageUrl: `${PORTAL}/d/j93s-yemu`,
    departmentCodes: ["25"],
    coverage:
      "Servicios habilitados por sede de todos los prestadores de Cundinamarca, publicados por MinSalud con corte del 29 de junio de 2022.",
    fields: {
      providerCode: "codigo_habilitacion",
      siteNumber: "numero_sede",
      serviceCode: "serv_codigo",
      serviceName: "serv_nombre",
      status: "habilitado",
      personKind: "clase_persona",
      cutoff: "fecha_corte_reps",
    },
    modalities: MODALITIES,
  },
  {
    key: "reps-servicios-boyaca",
    name: "Servicios habilitados – red pública de Boyacá (Gobernación)",
    datasetId: "p9n2-9qsb",
    pageUrl: `${PORTAL}/d/p9n2-9qsb`,
    departmentCodes: ["15"],
    coverage:
      "Servicios habilitados por sede de la red pública (ESE) de Boyacá, publicados por la Gobernación (actualizado en el portal el 28 de junio de 2023). No incluye prestadores privados.",
    fields: {
      providerCode: "codigo_habilitacion",
      siteNumber: "num_sede",
      serviceCode: "codigo_servicio",
      serviceName: "servicio",
    },
    modalities: MODALITIES,
  },
];

/** Código de sede del REPS nacional: código de habilitación + número de sede de dos dígitos. */
export function siteCodeOf(providerCode: string, siteNumber: string): string | null {
  const p = providerCode.trim();
  const n = siteNumber.trim();
  if (!/^\d{10}$/.test(p) || !/^\d{1,2}$/.test(n)) return null;
  return `${p}${n.padStart(2, "0")}`;
}

const metadataSchema = z.object({
  rowsUpdatedAt: z.number().optional(),
  columns: z.array(z.object({ fieldName: z.string() })),
});
const countSchema = z.tuple([z.object({ total: z.string().regex(/^\d+$/) })]);
const digits = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d+$/));

export interface ServiceSourceOptions {
  fetch?: typeof fetch;
  pageSize?: number;
  timeoutMs?: number;
}

export function createServiceSourceAdapter(
  config: ServiceDatasetConfig,
  options: ServiceSourceOptions = {},
): SourceAdapter {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const pageSize = options.pageSize ?? 1000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const resource = `${PORTAL}/resource/${config.datasetId}.json`;
  const f = config.fields;
  const rowSchema = z.object({
    [f.providerCode]: digits,
    [f.siteNumber]: digits,
    [f.serviceCode]: digits,
    [f.serviceName]: z.string().min(1),
  });
  const required = [
    f.providerCode,
    f.siteNumber,
    f.serviceCode,
    f.serviceName,
    ...[f.status, f.personKind, f.cutoff].filter((x): x is string => Boolean(x)),
    ...Object.keys(config.modalities),
  ];

  async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new SourceUnavailableError(
        timedOut
          ? `${config.name} no respondió en ${Math.round(timeoutMs / 1000)} s`
          : `No se pudo conectar con ${config.name}`,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
      throw new SourceHttpError(
        res.status,
        typeof body?.message === "string" ? body.message.slice(0, 200) : undefined,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new SourceSchemaError("la respuesta no es JSON válido");
    }
  }

  function parseRow(payload: unknown, position: string) {
    const parsed = rowSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SourceSchemaError(
        `${config.name}, registro ${position}, campo "${issue?.path.join(".") || "(fila)"}": ${issue?.message ?? ""}`,
      );
    }
    return payload as Record<string, unknown>;
  }

  function resolveService(record: RawRecord): ResolvedServiceRecord {
    const row = parseRow(record.payload, record.externalId);
    const text = (field?: string) =>
      field && typeof row[field] === "string" ? (row[field] as string).trim() || null : null;
    const siteCode = siteCodeOf(String(row[f.providerCode]), String(row[f.siteNumber]));
    if (!siteCode) {
      throw new SourceSchemaError(
        `${config.name}: código de sede no válido en ${record.externalId}`,
      );
    }
    const person = text(f.personKind)?.toUpperCase();
    const cutoffRaw = text(f.cutoff);
    return {
      siteCode,
      serviceCode: String(row[f.serviceCode]),
      serviceName: String(row[f.serviceName]).trim(),
      status: text(f.status),
      modalities: Object.entries(config.modalities)
        .filter(([field]) => text(field)?.toUpperCase() === "SI")
        .map(([, label]) => label),
      personKind: person === "NATURAL" ? "natural" : person === "JURIDICO" ? "juridica" : null,
      sourceCutoffAt: cutoffRaw ? parseRepsCutoff(cutoffRaw) : null,
      sourceCutoffRaw: cutoffRaw,
    };
  }

  async function* discover(query: SearchQuery, hooks: DiscoverHooks = {}) {
    const codes = query.serviceCodes ?? [];
    if (codes.length === 0 || codes.some((c) => !/^\d{1,5}$/.test(c))) {
      throw new SourceQueryError("Se requieren códigos de servicio del catálogo");
    }
    if (!(query.departmentCodes ?? []).some((d) => config.departmentCodes.includes(d))) {
      throw new SourceQueryError(`${config.name} no cubre el departamento pedido`);
    }
    // Estructura: todas las columnas usadas deben existir.
    const meta = metadataSchema.safeParse(
      await getJson(`${PORTAL}/api/views/${config.datasetId}.json`, hooks.signal),
    );
    if (!meta.success) throw new SourceSchemaError(`${config.name}: metadatos sin columnas`);
    const declared = new Set(meta.data.columns.map((c) => c.fieldName));
    for (const col of required) {
      if (!declared.has(col))
        throw new SourceSchemaError(`${config.name}: falta la columna "${col}"`);
    }
    const updatedAt = meta.data.rowsUpdatedAt ? new Date(meta.data.rowsUpdatedAt * 1000) : null;

    // Las columnas de código son numéricas en el portal: sin comillas.
    const where = `${f.serviceCode} in (${codes.map((c) => String(Number(c))).join(", ")})`;
    const count = countSchema.safeParse(
      await getJson(
        `${resource}?${new URLSearchParams({ $select: "count(*) AS total", $where: where })}`,
        hooks.signal,
      ),
    );
    if (!count.success)
      throw new SourceSchemaError(`${config.name}: el conteo no tiene el formato esperado`);
    const expectedCount = Number(count.data[0].total);
    await hooks.onSnapshot?.({ expectedCount, updatedAt, pageUrl: config.pageUrl });

    let recordsRead = 0;
    let pagesRead = 0;
    const maxPages = Math.ceil(expectedCount / pageSize) + 2;
    for (let offset = 0; ; offset += pageSize) {
      if (pagesRead >= maxPages) {
        throw new SourceConsistencyError(`${config.name}: la paginación no terminó`);
      }
      const url = `${resource}?${new URLSearchParams({
        $where: where,
        // Identificador interno de fila: orden estable entre páginas.
        $order: ":id",
        $limit: String(pageSize),
        $offset: String(offset),
      })}`;
      const page = await getJson(url, hooks.signal);
      if (!Array.isArray(page))
        throw new SourceSchemaError(`${config.name}: la página no es una lista`);
      pagesRead++;
      for (const [i, payload] of page.entries()) {
        const row = parseRow(payload, `#${offset + i + 1}`);
        recordsRead++;
        const siteCode = siteCodeOf(String(row[f.providerCode]), String(row[f.siteNumber]));
        const serviceCode = String(row[f.serviceCode]);
        yield {
          externalId: `${siteCode}|${serviceCode}`,
          payload: row,
          url: `${resource}?${new URLSearchParams({
            [f.providerCode]: String(row[f.providerCode]),
            [f.siteNumber]: String(row[f.siteNumber]),
            [f.serviceCode]: serviceCode,
          })}`,
        } satisfies RawRecord;
      }
      await hooks.onPage?.({ pagesRead, recordsRead });
      if (page.length < pageSize) break;
    }
    if (recordsRead !== expectedCount) {
      throw new SourceConsistencyError(
        `${config.name} anunció ${expectedCount} registros y se leyeron ${recordsRead}`,
      );
    }
  }

  return {
    key: config.key,
    name: config.name,
    legalBasis: "open_data",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/legalcode",
    operational: true,
    role: "services",
    serviceCoverage: { departmentCodes: config.departmentCodes },
    searchCoverage: config.coverage,
    capabilities: ["discover"],
    discover,
    resolveService,
  };
}

export const serviceSourceAdapters = SERVICE_DATASETS.map((c) => createServiceSourceAdapter(c));
