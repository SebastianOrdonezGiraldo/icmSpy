/**
 * Validación del destino de las pruebas de integración de Instagram, antes de conectar o migrar.
 *
 * Se comprueba el destino EFECTIVO del controlador `pg` (lo que usaría al conectar), no el texto
 * de la URL: `pg` completa lo que falta con PGHOST, PGPORT, PGDATABASE… y un parámetro `?host=`
 * puede sustituir al host de la URL. Solo se acepta la instancia local desechable prevista.
 */
import pg from "pg";

export interface DisposableTarget {
  host: string;
  port: number;
  database: string;
  user: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/** Bases del proyecto que las pruebas nunca deben tocar. */
const FORBIDDEN_DATABASES = new Set([
  "icmspy",
  "icmspy_test",
  "postgres",
  "template0",
  "template1",
]);

/**
 * Devuelve el destino efectivo si es la instancia desechable prevista; si no, lanza.
 * `expectedPort` es obligatorio: identifica el contenedor creado para la prueba.
 */
export function checkDisposableTarget(url: string, expectedPort: number): DisposableTarget {
  if (!Number.isInteger(expectedPort) || expectedPort <= 0) {
    throw new Error("Falta el puerto esperado de la instancia desechable");
  }
  // Construir el cliente no conecta: solo resuelve parámetros (URL + variables PG*).
  const client = new pg.Client({ connectionString: url });
  const target: DisposableTarget = {
    host: String(client.host),
    port: Number(client.port),
    database: String(client.database),
    user: String(client.user),
  };
  if (!LOOPBACK.has(target.host)) {
    throw new Error(`Destino no local: el controlador conectaría a ${target.host}`);
  }
  if (target.port !== expectedPort) {
    throw new Error(`Puerto ${target.port} distinto del esperado (${expectedPort})`);
  }
  if (FORBIDDEN_DATABASES.has(target.database) || !target.database.startsWith("ig_")) {
    throw new Error(`Base no permitida para pruebas desechables: ${target.database}`);
  }
  return target;
}

/** Comprobación tras conectar y antes de migrar: misma base, PostgreSQL 16 y UTF8. */
export async function checkDisposableServer(pool: pg.Pool, target: DisposableTarget) {
  const r = await pool.query<{ db: string; version: number; encoding: string }>(
    "select current_database() as db, current_setting('server_version_num')::int as version, current_setting('server_encoding') as encoding",
  );
  const row = r.rows[0];
  if (!row || row.db !== target.database) {
    throw new Error(`La conexión apunta a ${row?.db}, no a ${target.database}`);
  }
  if (row.version < 160000 || row.version >= 170000) {
    throw new Error(`Se esperaba PostgreSQL 16 (server_version_num ${row.version})`);
  }
  if (row.encoding !== "UTF8") throw new Error(`Codificación ${row.encoding}, se esperaba UTF8`);
  return row;
}
