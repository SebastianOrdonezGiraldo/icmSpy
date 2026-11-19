/**
 * Fixtures de REPS saneados: misma estructura, nombres de campo y formatos
 * que la respuesta real de datos.gov.co (consultada el 2026-11-13), pero con
 * nombres, NIT, correos y teléfonos ficticios.
 */
import type { RepsRow } from "../modules/discovery/adapters/reps";

export const IPS = "Instituciones Prestadoras de Servicios de Salud - IPS";
export const CUTOFF = "Fecha corte REPS: Mar 12 2026  3:11PM";

/** Las columnas que el portal declara en /api/views/c36g-9fc2.json. */
export const REPS_METADATA = {
  rowsUpdatedAt: 1776455843,
  columns: [
    ["codigoprestador", "text"],
    ["nombreprestador", "text"],
    ["codigohabilitacionsede", "text"],
    ["nombresede", "text"],
    ["tipoid", "text"],
    ["numeroidentificacion", "number"],
    ["naturalezajuridica", "text"],
    ["ese", "text"],
    ["municipio_prestador", "text"],
    ["departamentoprestadordesc", "text"],
    ["municipioprestadordesc", "text"],
    ["direccionprestador", "text"],
    ["email_prestador", "text"],
    ["telefonoprestador", "text"],
    ["municipiosede", "text"],
    ["departamentodededesc", "text"],
    ["municipiosededesc", "text"],
    ["direcci_nsede", "text"],
    ["email_sede", "text"],
    ["t_lefonosede", "text"],
    ["claseprestador", "text"],
    ["fecha_corte_reps", "text"],
  ].map(([fieldName, dataTypeName]) => ({ fieldName, dataTypeName })),
};

type Row = { [K in keyof RepsRow]?: RepsRow[K] | string };

export function repsRow(overrides: Row = {}): Record<string, unknown> {
  return {
    codigoprestador: "6300100001",
    nombreprestador: "CLINICA EJEMPLO DEL QUINDIO S.A.S.",
    codigohabilitacionsede: "630010000101",
    nombresede: "CLINICA EJEMPLO SEDE CENTRO",
    tipoid: "NI",
    numeroidentificacion: "900000001",
    naturalezajuridica: "Privada",
    ese: "NO",
    municipio_prestador: "63001",
    departamentoprestadordesc: "Quindío",
    municipioprestadordesc: "ARMENIA",
    direccionprestador: "CALLE 1 # 2-3",
    email_prestador: "gerencia@ejemplo.test",
    telefonoprestador: "6067000001",
    municipiosede: "63001",
    departamentodededesc: "Quindío",
    municipiosededesc: "ARMENIA",
    direcci_nsede: "CALLE 1 # 2-3",
    email_sede: "info@ejemplo.test",
    t_lefonosede: "7000002 - 3000000003",
    claseprestador: IPS,
    fecha_corte_reps: CUTOFF,
    ...overrides,
  };
}

/** Dos sedes del mismo NIT en municipios distintos, con contactos distintos. */
export const multiSiteRows = [
  repsRow(),
  repsRow({
    codigohabilitacionsede: "630010000102",
    nombresede: "CLINICA EJEMPLO SEDE CALARCA",
    municipiosede: "63130",
    municipiosededesc: "CALARCA",
    direcci_nsede: "CARRERA 9 # 8-7",
    email_sede: "calarca@ejemplo.test",
    t_lefonosede: "3000000004",
  }),
];

export interface FakeSocrataOptions {
  rows: Record<string, unknown>[];
  /** Conteo que anuncia la fuente; por defecto, el número de filas. */
  count?: number;
  metadata?: unknown;
  /** Respuesta forzada para la petición número n (0 = metadatos, 1 = conteo, 2.. = páginas). */
  failAt?: { request: number; status: number; body?: unknown };
}

/**
 * Servidor Socrata simulado. Pagina con $offset/$limit sobre `rows` tal como
 * llegan (no aplica $where: así se prueba que el adaptador descarta filas
 * fuera del filtro). Guarda las URLs pedidas.
 */
export function fakeSocrata(options: FakeSocrataOptions) {
  const requests: URL[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const n = requests.push(url) - 1;
    if (options.failAt?.request === n) {
      return Response.json(options.failAt.body ?? { message: "fallo simulado" }, {
        status: options.failAt.status,
      });
    }
    if (url.pathname.startsWith("/api/views/")) {
      return Response.json(options.metadata ?? REPS_METADATA);
    }
    if (url.searchParams.get("$select")?.startsWith("count(")) {
      return Response.json([{ total: String(options.count ?? options.rows.length) }]);
    }
    const offset = Number(url.searchParams.get("$offset") ?? 0);
    const limit = Number(url.searchParams.get("$limit") ?? 1000);
    return Response.json(options.rows.slice(offset, offset + limit));
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}

// --- Servicios habilitados (estructura de j93s-yemu, MinSalud) ---------------

export const SERVICES_CUTOFF = "Fecha corte REPS: Jun 29 2022 12:39PM";

/** Columnas que declara el portal para el conjunto de servicios. */
export const SERVICE_METADATA = {
  rowsUpdatedAt: 1656945600,
  columns: [
    "codigo_habilitacion",
    "numero_sede",
    "serv_codigo",
    "serv_nombre",
    "habilitado",
    "clase_persona",
    "fecha_corte_reps",
    "ambulatorio",
    "hospitalario",
    "unidad_movil",
    "domiciliario",
    "otras_extramural",
  ].map((fieldName) => ({ fieldName, dataTypeName: "text" })),
};

/** Fila de servicio habilitado: código de habilitación de 10 dígitos + número de sede. */
export function serviceRow(
  siteCode: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    codigo_habilitacion: siteCode.slice(0, 10),
    numero_sede: String(Number(siteCode.slice(10))),
    serv_codigo: "739",
    serv_nombre: "FISIOTERAPIA",
    habilitado: "SI",
    clase_persona: "JURIDICO",
    fecha_corte_reps: SERVICES_CUTOFF,
    ambulatorio: "SI",
    hospitalario: "NO",
    unidad_movil: "NO",
    domiciliario: "SI",
    otras_extramural: "NO",
    ...overrides,
  };
}

export interface FakeSourcesOptions {
  /** Sedes de REPS que la consulta geográfica devuelve. */
  reps: Record<string, unknown>[];
  /** Sedes de REPS que existen fuera del lugar consultado (para la consulta por código). */
  repsElsewhere?: Record<string, unknown>[];
  /** Filas del conjunto de servicios. */
  services?: Record<string, unknown>[];
  /** Estado HTTP forzado para cualquier petición al conjunto de servicios. */
  failServices?: number;
}

/**
 * Portal simulado con REPS y un conjunto de servicios. No aplica $where salvo
 * en la consulta de sedes por código (así se prueban los descartes del worker).
 */
export function fakeSources(options: FakeSourcesOptions) {
  const requests: URL[] = [];
  const page = (rows: Record<string, unknown>[], url: URL) => {
    if (url.searchParams.get("$select")?.startsWith("count(")) {
      return Response.json([{ total: String(rows.length) }]);
    }
    const offset = Number(url.searchParams.get("$offset") ?? 0);
    const limit = Number(url.searchParams.get("$limit") ?? 1000);
    return Response.json(rows.slice(offset, offset + limit));
  };
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    requests.push(url);
    const isServices = url.pathname.includes("j93s-yemu");
    if (isServices && options.failServices) {
      return Response.json({ message: "fallo simulado" }, { status: options.failServices });
    }
    if (url.pathname.startsWith("/api/views/")) {
      return Response.json(isServices ? SERVICE_METADATA : REPS_METADATA);
    }
    if (isServices) return page(options.services ?? [], url);
    const where = url.searchParams.get("$where") ?? "";
    if (where.startsWith("codigohabilitacionsede in")) {
      const codes = new Set([...where.matchAll(/'(\d+)'/g)].map((m) => m[1]));
      const all = [...options.reps, ...(options.repsElsewhere ?? [])];
      return Response.json(all.filter((r) => codes.has(String(r.codigohabilitacionsede))));
    }
    return page(options.reps, url);
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}
