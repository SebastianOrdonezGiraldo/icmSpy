import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  companies,
  companySites,
  contactPointSites,
  contactPoints,
  type createDb,
  dataProvenance,
  searchRuns,
  sourceRecords,
  user,
} from "@icmspy/db";
import { QUEUES, searchCriteriaSchema } from "@icmspy/shared";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createQueue, type JobAttemptInfo, type Queue } from "../lib/queue";
import { getCompany, listCompanies } from "../modules/companies";
import { suppress } from "../modules/compliance";
import { createRepsAdapter } from "../modules/discovery/adapters/reps";
import { createImportDatasetHandler } from "../modules/discovery/jobs/import-dataset";

/** Consulta de la búsqueda fija anterior al buscador: las ejecuciones antiguas siguen funcionando. */
const LEGACY_QUERY = { preset: "reps-quindio", departmentCodes: ["63"], providerClass: "ips" };
/** Criterios del buscador configurable. */
const CRITERIA = { keyword: "clinica", departmentCode: "63", municipalityCode: null };
/** Para listar ejecuciones ya cerradas: la reconciliación solo consulta la cola si siguen activas. */
const noQueue = {} as Queue;

import { planSearch } from "../modules/search-runs/presets";
import { getSearchRunResults } from "../modules/search-runs/results";
import {
  createSearchRun,
  failAttempt,
  getSearchRun,
  listSearchRuns,
  loadRun,
  startAttempt,
  toSearchRunDto,
} from "../modules/search-runs/service";
import { resetData, setupTestDb, TEST_DATABASE_URL } from "./db";
import { type FakeSocrataOptions, fakeSocrata, multiSiteRows, repsRow } from "./reps-fixtures";

type Db = ReturnType<typeof createDb>["db"];
type Pool = ReturnType<typeof createDb>["pool"];

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const USER_ID = "test-user";

describeDb("búsqueda REPS contra PostgreSQL", () => {
  let db: Db;
  let pool: Pool;

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb(TEST_DATABASE_URL as string));
    await db
      .insert(user)
      .values({ id: USER_ID, name: "Prueba", email: "prueba@icm.test" })
      .onConflictDoNothing();
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await resetData(db);
  });

  /** `variant` distingue la consulta: solo puede haber una ejecución activa por consulta. */
  async function newRun(variant?: string) {
    const adapter = "reps";
    const query = LEGACY_QUERY;
    const [run] = await db
      .insert(searchRuns)
      .values({ adapter, query: variant ? { ...query, variant } : query })
      .returning();
    if (!run) throw new Error("sin run");
    return run;
  }

  function attempt(retryCount = 0, retryLimit = 2): JobAttemptInfo {
    return { id: "job", retryCount, retryLimit, signal: new AbortController().signal };
  }

  async function runImport(
    socrata: FakeSocrataOptions,
    opts: {
      runId?: string;
      job?: JobAttemptInfo;
      pageSize?: number;
      variant?: string;
      /** Se ejecuta antes de cada petición a la fuente simulada. */
      beforeFetch?: (runId: string) => Promise<void>;
    } = {},
  ) {
    const runId = opts.runId ?? (await newRun(opts.variant)).id;
    const api = fakeSocrata(socrata);
    const fetchImpl: typeof fetch = async (input, init) => {
      await opts.beforeFetch?.(runId);
      return api.fetch(input, init);
    };
    const handler = createImportDatasetHandler({
      db,
      pool,
      getAdapter: () => createRepsAdapter({ fetch: fetchImpl, pageSize: opts.pageSize }),
    });
    const error = await handler(
      { adapter: "reps", searchRunId: runId },
      opts.job ?? attempt(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    const run = await loadRun(db, runId);
    if (!run) throw new Error("run desaparecido");
    return { run, error };
  }

  async function totals() {
    const { rows } = await pool.query(`select
      (select count(*)::int from companies) as companies,
      (select count(*)::int from company_sites) as sites,
      (select count(*)::int from contact_points) as contacts,
      (select count(*)::int from contact_point_sites) as links,
      (select count(*)::int from source_records) as records,
      (select count(*)::int from data_provenance) as provenance,
      (select count(*)::int from search_run_results) as results`);
    return rows[0] as {
      companies: number;
      sites: number;
      contacts: number;
      links: number;
      records: number;
      provenance: number;
      results: number;
    };
  }

  it("incorpora una empresa con varias sedes sin mezclar municipios ni contactos", async () => {
    const { run, error } = await runImport({ rows: multiSiteRows });
    expect(error).toBeNull();
    expect(run.status).toBe("done");
    expect(run.foundCount).toBe(2);
    expect(run.newCount).toBe(1);
    expect(run.stats).toMatchObject({
      recordsRead: 2,
      recordsNew: 2,
      companiesNew: 1,
      sitesNew: 2,
      contactsNew: 7,
      contactsSuppressed: 0,
      sourceCutoffAt: "2026-03-12T20:11:00.000Z",
    });

    const [company] = await db.select().from(companies);
    expect(company).toMatchObject({ nit: "900000001", city: "ARMENIA", companyType: "ips" });
    const sites = await db
      .select({ id: companySites.id, city: companySites.city, address: companySites.address })
      .from(companySites)
      .orderBy(companySites.externalId);
    expect(sites.map((s) => [s.city, s.address])).toEqual([
      ["ARMENIA", "CALLE 1 # 2-3"],
      ["CALARCA", "CARRERA 9 # 8-7"],
    ]);

    const linked = await db
      .select({ value: contactPoints.valueNormalized, siteId: contactPointSites.siteId })
      .from(contactPoints)
      .leftJoin(contactPointSites, eq(contactPointSites.contactPointId, contactPoints.id));
    const siteOf = (v: string) => linked.filter((l) => l.value === v).map((l) => l.siteId);
    expect(siteOf("info@ejemplo.test")).toEqual([sites[0]?.id]);
    expect(siteOf("calarca@ejemplo.test")).toEqual([sites[1]?.id]);
    // Contacto del prestador: de la empresa, no de una sede.
    expect(siteOf("gerencia@ejemplo.test")).toEqual([null]);

    const emails = await db
      .select({ status: contactPoints.validationStatus, role: contactPoints.isRoleAddress })
      .from(contactPoints)
      .where(eq(contactPoints.kind, "email"));
    expect(emails.every((e) => e.status === "unknown")).toBe(true);

    const prov = await db
      .select({ url: dataProvenance.url, field: dataProvenance.field })
      .from(dataProvenance)
      .where(eq(dataProvenance.entityType, "contact_point"));
    expect(prov).toContainEqual({
      field: "email_sede",
      url: "https://www.datos.gov.co/resource/c36g-9fc2.json?codigohabilitacionsede=630010000102",
    });
  });

  it("el listado y la ficha muestran sedes, contactos por sede y procedencia", async () => {
    await runImport({ rows: multiSiteRows });
    const list = await listCompanies(db, { page: 1, pageSize: 25 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ siteCount: 2, contactCount: 7 });
    const detail = await getCompany(db, list.items[0]?.id as string);
    expect(detail?.sites.map((s) => s.city)).toEqual(["ARMENIA", "CALARCA"]);
    const calarca = detail?.sites.find((s) => s.city === "CALARCA");
    const email = detail?.contactPoints.find((p) => p.value === "calarca@ejemplo.test");
    expect(email?.siteIds).toEqual([calarca?.id]);
    expect(email?.sources).toEqual([
      expect.objectContaining({ sourceKey: "reps", field: "email_sede", url: calarca?.sourceUrl }),
    ]);
    // El contacto del prestador aparece en ambas sedes: una entrada por registro original.
    const shared = detail?.contactPoints.find((p) => p.value === "gerencia@ejemplo.test");
    expect(shared?.siteIds).toEqual([]);
    expect(shared?.sources).toHaveLength(2);
  });

  it("repetir la búsqueda no duplica nada y lo informa como existente", async () => {
    await runImport({ rows: multiSiteRows });
    const before = await totals();
    const { run } = await runImport({ rows: multiSiteRows });
    expect(await totals()).toEqual({ ...before, results: before.results + 2 }); // solo los resultados de la nueva ejecución
    expect(run.newCount).toBe(0);
    expect(run.stats).toMatchObject({
      recordsNew: 0,
      recordsUnchanged: 2,
      companiesNew: 0,
      companiesExisting: 1,
      sitesNew: 0,
      sitesExisting: 2,
      contactsNew: 0,
      contactsExisting: 7,
    });
  });

  it("conserva la historia del original cuando cambia, sin duplicar la empresa", async () => {
    await runImport({ rows: multiSiteRows });
    const changed = [{ ...multiSiteRows[0], email_sede: "nuevo@ejemplo.test" }, multiSiteRows[1]];
    const { run } = await runImport({ rows: changed as Record<string, unknown>[] });
    const t = await totals();
    expect(t.records).toBe(3);
    expect(t.companies).toBe(1);
    expect(t.sites).toBe(2);
    expect(run.stats).toMatchObject({ recordsNew: 1, recordsUnchanged: 1, contactsNew: 1 });
  });

  it("dos búsquedas simultáneas no duplican empresas, sedes ni contactos", async () => {
    const [a, b] = await Promise.all([
      runImport({ rows: multiSiteRows }),
      // Mismo contenido por otra consulta: la base no deja dos ejecuciones activas de la misma.
      runImport({ rows: multiSiteRows }, { variant: "paralela" }),
    ]);
    expect([a.run.status, b.run.status]).toEqual(["done", "done"]);
    expect(await totals()).toMatchObject({ companies: 1, sites: 2, contacts: 7, records: 2 });
    expect(a.run.newCount + b.run.newCount).toBe(1);
  });

  it("omite los contactos suprimidos y no los conserva en el original", async () => {
    await suppress(db, "email", "calarca@ejemplo.test", "solicitud habeas data");
    await suppress(db, "phone", "+573000000004", "solicitud habeas data");
    const { run } = await runImport({ rows: multiSiteRows });
    const values = (await db.select({ v: contactPoints.valueNormalized }).from(contactPoints)).map(
      (r) => r.v,
    );
    expect(values).not.toContain("calarca@ejemplo.test");
    expect(values).not.toContain("+573000000004");
    expect(run.stats).toMatchObject({ contactsSuppressed: 2, contactsNew: 5 });
    const [stored] = await db
      .select({ payload: sourceRecords.payload })
      .from(sourceRecords)
      .where(eq(sourceRecords.externalId, "630010000102"));
    expect(JSON.stringify(stored?.payload)).not.toContain("calarca@");
    expect(JSON.stringify(stored?.payload)).toContain("[suprimido]");
  });

  it("aplica la supresión por dominio a los correos", async () => {
    await suppress(db, "domain", "ejemplo.test", "dominio excluido");
    await runImport({ rows: multiSiteRows });
    const kinds = (await db.select({ k: contactPoints.kind }).from(contactPoints)).map((r) => r.k);
    expect(kinds).not.toContain("email");
  });

  it("no pisa los datos que otra fuente ya aportó", async () => {
    await db.insert(companies).values({
      nit: "900000001",
      legalName: "NOMBRE DE OTRA FUENTE",
      city: "PEREIRA",
      companyType: "otro",
    });
    await runImport({ rows: multiSiteRows });
    const [c] = await db.select().from(companies);
    expect(c).toMatchObject({
      legalName: "NOMBRE DE OTRA FUENTE",
      city: "PEREIRA",
      department: "Quindío",
      companyType: "ips",
    });
  });

  it("agrupa sedes sin NIT por código de prestador y nunca fusiona por nombre", async () => {
    const natural = (code: string) =>
      repsRow({
        tipoid: "CC",
        numeroidentificacion: "10000001",
        codigoprestador: "6300100099",
        codigohabilitacionsede: code,
      });
    // Otra empresa con el mismo nombre pero NIT propio: debe quedar aparte.
    const homonym = repsRow({
      codigoprestador: "6300100050",
      codigohabilitacionsede: "630010005001",
      numeroidentificacion: "900000050",
    });
    const rows = [natural("630010009901"), natural("630010009902"), homonym];
    await runImport({ rows });
    await runImport({ rows });
    const all = await db.select({ nit: companies.nit }).from(companies).orderBy(companies.nit);
    expect(all.map((c) => c.nit)).toEqual(["900000050", null]);
    const [noNit] = await db
      .select({ n: count() })
      .from(companySites)
      .innerJoin(companies, eq(companies.id, companySites.companyId))
      .where(sql`${companies.nit} is null`);
    expect(noNit?.n).toBe(2);
  });

  it("incorpora los teléfonos con formatos históricos o compuestos sin duplicar ni saltar la supresión", async () => {
    // Patrones observados en REPS Quindío, con valores ficticios.
    const rows = [
      repsRow({
        email_sede: "sede1@ejemplo.test",
        t_lefonosede: "(096) 7000010 o 7000-011, (036) 7000015",
        telefonoprestador: "967000012",
      }),
      repsRow({
        codigohabilitacionsede: "630010000102",
        municipiosede: "63130",
        municipiosededesc: "CALARCA",
        email_sede: "sede2@ejemplo.test",
        t_lefonosede: "fijo 606 7000013 Cel 3000000014",
        telefonoprestador: "967000012",
      }),
    ];
    await suppress(db, "phone", "+576067000011", "solicitud habeas data");

    const { run } = await runImport({ rows });
    expect(run.status).toBe("done");
    expect(run.stats).toMatchObject({
      contactsNew: 7, // 3 correos + 4 teléfonos
      contactsExisting: 0,
      contactsSuppressed: 1,
      contactsDiscarded: 1, // "(036) 7000015": "03" no es un código de operador
    });

    const phones = await db
      .select({
        id: contactPoints.id,
        value: contactPoints.value,
        normalized: contactPoints.valueNormalized,
        status: contactPoints.validationStatus,
        site: companySites.externalId,
      })
      .from(contactPoints)
      .leftJoin(contactPointSites, eq(contactPointSites.contactPointId, contactPoints.id))
      .leftJoin(companySites, eq(companySites.id, contactPointSites.siteId))
      .where(eq(contactPoints.kind, "phone"))
      .orderBy(contactPoints.valueNormalized);
    // Valor original conservado, normalizado canónico y vínculo con la sede correcta.
    expect(phones.map(({ value, normalized, site }) => ({ value, normalized, site }))).toEqual([
      { value: "3000000014", normalized: "+573000000014", site: "630010000102" },
      { value: "(096) 7000010", normalized: "+576067000010", site: "630010000101" },
      // Del prestador: de la empresa, sin sede.
      { value: "967000012", normalized: "+576067000012", site: null },
      { value: "606 7000013", normalized: "+576067000013", site: "630010000102" },
    ]);
    expect(phones.every((p) => p.status === "unknown")).toBe(true);
    // Una sola empresa para ambas sedes.
    expect((await totals()).companies).toBe(1);

    // Procedencia: el teléfono del prestador, una vez por cada registro que lo publica.
    const prestador = phones.find((p) => p.normalized === "+576067000012");
    const prov = await db
      .select({ field: dataProvenance.field, url: dataProvenance.url })
      .from(dataProvenance)
      .where(eq(dataProvenance.entityId, prestador?.id as string))
      .orderBy(dataProvenance.url);
    expect(prov).toEqual([
      {
        field: "telefonoprestador",
        url: "https://www.datos.gov.co/resource/c36g-9fc2.json?codigohabilitacionsede=630010000101",
      },
      {
        field: "telefonoprestador",
        url: "https://www.datos.gov.co/resource/c36g-9fc2.json?codigohabilitacionsede=630010000102",
      },
    ]);

    // Repetir no duplica nada y lo informa como existente.
    const before = await totals();
    const again = await runImport({ rows });
    expect(await totals()).toEqual({ ...before, results: before.results + 2 }); // solo los resultados de la nueva ejecución
    expect(again.run.stats).toMatchObject({
      contactsNew: 0,
      contactsExisting: 7,
      contactsSuppressed: 1,
      contactsDiscarded: 1,
    });
  });

  it("descarta lo que está fuera del departamento o la clase", async () => {
    const { run } = await runImport({
      rows: [
        repsRow(),
        repsRow({ codigohabilitacionsede: "660010000101", municipiosede: "66001" }),
      ],
    });
    expect(run.stats).toMatchObject({ recordsRead: 2, recordsExcluded: 1 });
    expect((await totals()).sites).toBe(1);
  });

  it("un resultado vacío termina como hecho y sin datos", async () => {
    const { run, error } = await runImport({ rows: [] });
    expect(error).toBeNull();
    expect(run).toMatchObject({ status: "done", foundCount: 0, newCount: 0 });
    expect(run.stats).toMatchObject({ recordsExpected: 0, recordsRead: 0 });
  });

  it("un fallo intermedio no deja datos a medias y queda pendiente de reintento", async () => {
    const { run, error } = await runImport(
      { rows: multiSiteRows, failAt: { request: 3, status: 503 } },
      { pageSize: 1 },
    );
    expect(error).toBeTruthy();
    expect(run.status).toBe("queued");
    expect(run.error).toMatch(/Intento 1 de 3 falló: La fuente respondió con error HTTP 503/);
    expect(await totals()).toMatchObject({ companies: 0, records: 0 });
  });

  it("un reintento exitoso no infla los contadores", async () => {
    const first = await runImport({ rows: multiSiteRows, failAt: { request: 2, status: 500 } });
    expect(first.run.status).toBe("queued");
    const { run } = await runImport(
      { rows: multiSiteRows },
      { runId: first.run.id, job: attempt(1) },
    );
    expect(run.status).toBe("done");
    expect(run.error).toBeNull();
    expect(run.foundCount).toBe(2);
    expect(run.stats).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
      companiesNew: 1,
      contactsNew: 7,
    });
  });

  it("el último intento fallido deja la búsqueda como fallida", async () => {
    const { run } = await runImport(
      { rows: multiSiteRows, failAt: { request: 0, status: 503 } },
      { job: attempt(2) },
    );
    expect(run.status).toBe("failed");
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toBe("La fuente respondió con error HTTP 503: fallo simulado");
  });

  describe("cierre atómico de la ejecución", () => {
    /** Un fallo real de PostgreSQL justo al marcar la ejecución como terminada. */
    async function failOnDone() {
      await pool.query(`
        create or replace function test_fail_on_done() returns trigger language plpgsql as $$
        begin
          if new.status = 'done' then raise exception 'fallo simulado al cerrar la ejecución'; end if;
          return new;
        end $$;
        drop trigger if exists test_fail_on_done on search_runs;
        create trigger test_fail_on_done before update on search_runs
          for each row execute function test_fail_on_done();`);
    }
    async function restoreDone() {
      await pool.query(`drop trigger if exists test_fail_on_done on search_runs;
        drop function if exists test_fail_on_done();`);
    }

    it("si falla el cierre, no queda nada incorporado ni contadores a medias", async () => {
      await failOnDone();
      let first: Awaited<ReturnType<typeof runImport>>;
      try {
        first = await runImport({ rows: multiSiteRows });
      } finally {
        await restoreDone();
      }
      // El fallo es el UPDATE que cierra la ejecución (Drizzle deja el error de PostgreSQL en `cause`).
      const err = first.error as Error & { cause?: Error };
      expect(err.message).toMatch(/update "search_runs" set "status"/);
      expect(err.cause?.message).toBe("fallo simulado al cerrar la ejecución");

      // Ni datos incorporados ni originales ni procedencia: el rollback fue completo.
      expect(await totals()).toEqual({
        companies: 0,
        sites: 0,
        contacts: 0,
        links: 0,
        records: 0,
        provenance: 0,
        results: 0,
      });
      // La ejecución no aparece terminada ni con resultados que no existen.
      expect(first.run).toMatchObject({ status: "queued", foundCount: 0, newCount: 0 });
      expect(first.run.finishedAt).toBeNull();
      expect(first.run.error).toBe(
        "Intento 1 de 3 falló: Error interno al procesar la búsqueda. Se reintentará.",
      );
      for (const key of [
        "recordsNew",
        "companiesNew",
        "sitesNew",
        "contactsNew",
        "contactsExisting",
      ]) {
        expect(first.run.stats).not.toHaveProperty(key);
      }

      // El reintento parte de cero y da los mismos contadores que una ejecución limpia.
      const retry = await runImport(
        { rows: multiSiteRows },
        { runId: first.run.id, job: attempt(1) },
      );
      expect(retry.error).toBeNull();
      expect(retry.run).toMatchObject({ status: "done", foundCount: 2, newCount: 1, error: null });
      expect(retry.run.stats).toMatchObject({
        attempt: 2,
        recordsNew: 2,
        companiesNew: 1,
        sitesNew: 2,
        contactsNew: 7,
        contactsExisting: 0,
      });
      expect(await totals()).toMatchObject({ companies: 1, sites: 2, contacts: 7, records: 2 });
    });

    it("reintentar una ejecución ya confirmada conserva su resultado", async () => {
      const { run: done } = await runImport({ rows: multiSiteRows });
      expect(done.status).toBe("done");
      const before = await totals();

      // pg-boss vuelve a entregar el job (p. ej. el worker cayó tras el commit),
      // ahora con la fuente devolviendo otra cosa: no debe reimportar ni reabrir.
      const changed = [{ ...multiSiteRows[0], email_sede: "otro@ejemplo.test" }];
      const again = await runImport(
        { rows: changed as Record<string, unknown>[] },
        { runId: done.id, job: attempt(1) },
      );
      expect(again.error).toBeNull();
      expect(again.run).toEqual(done);
      expect(await totals()).toEqual(before);

      // Las transiciones de fallo tampoco pisan un resultado confirmado.
      await failAttempt(db, done.id, { message: "tardío", final: true, stats: { attempt: 9 } });
      expect(await startAttempt(db, done.id, { attempt: 9 })).toBe("closed");
      expect(await loadRun(db, done.id)).toEqual(done);
    });

    it("un intento reemplazado por otro no escribe datos ni cambia el estado", async () => {
      // Mientras este intento lee la fuente, pg-boss lo da por vencido y empieza el intento 2.
      const { run, error } = await runImport(
        { rows: multiSiteRows },
        {
          beforeFetch: async (runId) => {
            await startAttempt(db, runId, { attempt: 2, maxAttempts: 3 });
          },
        },
      );
      expect(error).toBeNull();
      expect(run.status).toBe("running");
      expect(run.stats).toMatchObject({ attempt: 2 });
      expect(run.error).toBeNull();
      expect((await totals()).companies).toBe(0);
    });

    it("no acepta iniciar un intento anterior al registrado y conserva el intento 2", async () => {
      const { id } = await newRun();
      let fetches = 0;
      const countFetch = async () => {
        fetches++;
      };

      // El intento 2 está en curso, con su progreso registrado.
      expect(
        await startAttempt(db, id, {
          attempt: 2,
          maxAttempts: 3,
          phase: "fetching",
          recordsRead: 7,
        }),
      ).toBe("started");
      const attempt2Running = await loadRun(db, id);

      // Llega tarde el intento 1: se rechaza sin tocar la fila.
      expect(await startAttempt(db, id, { attempt: 1, maxAttempts: 3 })).toBe("superseded");
      expect(await loadRun(db, id)).toEqual(attempt2Running);

      // Lo mismo por el handler: se retira como reemplazado, sin error, sin leer la fuente.
      const late = await runImport(
        { rows: multiSiteRows },
        { runId: id, job: attempt(0), beforeFetch: countFetch },
      );
      expect(late.error).toBeNull();
      expect(fetches).toBe(0);
      expect(late.run).toEqual(attempt2Running);
      expect(late.run).toMatchObject({ status: "running", error: null, foundCount: 0 });
      expect(late.run.stats).toEqual({
        attempt: 2,
        maxAttempts: 3,
        phase: "fetching",
        recordsRead: 7,
      });
      expect(await totals()).toMatchObject({ companies: 0, records: 0 });

      // El intento 2 termina e incorpora sus datos.
      const finished = await runImport({ rows: multiSiteRows }, { runId: id, job: attempt(1) });
      expect(finished.error).toBeNull();
      expect(finished.run).toMatchObject({ status: "done", foundCount: 2, newCount: 1 });
      expect(finished.run.stats).toMatchObject({ attempt: 2, companiesNew: 1, contactsNew: 7 });
      const attempt2Data = await totals();

      // Un intento 1 tardío después de confirmado tampoco cambia el resultado ni los datos.
      expect(await startAttempt(db, id, { attempt: 1, maxAttempts: 3 })).toBe("closed");
      const lateAgain = await runImport(
        { rows: [repsRow({ email_sede: "tardio@ejemplo.test" })] },
        { runId: id, job: attempt(0), beforeFetch: countFetch },
      );
      expect(lateAgain.error).toBeNull();
      expect(fetches).toBe(0);
      expect(lateAgain.run).toEqual(finished.run);
      expect(await totals()).toEqual(attempt2Data);
    });
  });

  it("un cambio de estructura falla de inmediato, sin reintentos inútiles", async () => {
    const broken = [repsRow({ municipiosede: "ARMENIA" })];
    const { run } = await runImport({ rows: broken });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/La estructura de la fuente cambió/);
    // pg-boss lo reentregará; el handler lo rechaza sin tocar el estado.
    const again = await runImport({ rows: multiSiteRows }, { runId: run.id, job: attempt(1) });
    expect(again.error).toBeTruthy();
    expect(again.run.status).toBe("failed");
    expect((await totals()).companies).toBe(0);
  });

  describe("buscador configurable", () => {
    /** Ejecuta una búsqueda con criterios del usuario contra una fuente simulada. */
    async function search(
      input: { keyword: string; departmentCode: string; municipalityCode?: string | null },
      rows: Record<string, unknown>[],
    ) {
      const plan = planSearch(searchCriteriaSchema.parse(input));
      const [created] = await db
        .insert(searchRuns)
        .values({ adapter: plan.adapter, query: plan.query })
        .returning();
      const { run, error } = await runImport({ rows }, { runId: created?.id as string });
      const results = await getSearchRunResults(db, run.id, 1, 50);
      return { run, error, results };
    }

    const armenia = (code: string, overrides: Parameters<typeof repsRow>[0] = {}) =>
      repsRow({
        codigohabilitacionsede: code,
        codigoprestador: code.slice(0, 10),
        numeroidentificacion: `9${code.slice(-8)}`,
        nombreprestador: "IPS EJEMPLO SAS",
        nombresede: "SEDE CENTRO",
        email_sede: `${code}@ejemplo.test`,
        t_lefonosede: null,
        email_prestador: null,
        telefonoprestador: null,
        ...overrides,
      });
    const odontoA = armenia("630010000101", { nombreprestador: "CLÍNICA ODONTOLÓGICA ALFA SAS" });
    const odontoB = armenia("631300000201", {
      municipiosede: "63130",
      municipiosededesc: "CALARCA",
      nombresede: "SEDE ODONTOLOGIA CALARCA",
    });
    const medico = armenia("630010000301", { nombreprestador: "CENTRO MEDICO GAMMA SAS" });
    const rows = [odontoA, odontoB, medico];
    const names = (r: Awaited<ReturnType<typeof search>>) =>
      r.results.items.map((i) => i.legalName).sort();

    it("dos búsquedas distintas tienen resultados propios", async () => {
      const a = await search({ keyword: "Odontológica", departmentCode: "63" }, rows);
      expect(a.error).toBeNull();
      // "odontologica" está en el nombre del prestador A y "odontologia" no la contiene.
      expect(names(a)).toEqual(["CLÍNICA ODONTOLÓGICA ALFA SAS"]);

      const b = await search({ keyword: "odontolog", departmentCode: "63" }, rows);
      expect(names(b)).toEqual(["CLÍNICA ODONTOLÓGICA ALFA SAS", "IPS EJEMPLO SAS"]);
      expect(b.run.stats).toMatchObject({
        recordsRead: 3,
        recordsMatched: 2,
        recordsNotMatching: 1,
        companiesMatched: 2,
        sitesMatched: 2,
      });

      const c = await search(
        { keyword: "medico", departmentCode: "63", municipalityCode: "63001" },
        rows,
      );
      expect(names(c)).toEqual(["CENTRO MEDICO GAMMA SAS"]);
      // Los resultados de cada ejecución no se mezclan.
      expect(names(await search({ keyword: "Odontológica", departmentCode: "63" }, rows))).toEqual(
        names(a),
      );
    });

    it("repetir devuelve las empresas existentes como resultado sin duplicarlas", async () => {
      const first = await search({ keyword: "odontolog", departmentCode: "63" }, rows);
      expect(first.run.stats).toMatchObject({ companiesNew: 2, companiesExisting: 0 });
      expect(first.results.items.every((i) => i.isNew)).toBe(true);
      const before = await totals();

      const again = await search({ keyword: "odontolog", departmentCode: "63" }, rows);
      expect(again.run.status).toBe("done");
      expect(again.run.newCount).toBe(0);
      expect(again.run.stats).toMatchObject({
        companiesMatched: 2,
        companiesNew: 0,
        companiesExisting: 2,
        recordsNew: 0,
        recordsUnchanged: 2,
      });
      // 2 resultados aunque 0 empresas nuevas; nada duplicado salvo las filas de resultados.
      expect(again.results.total).toBe(2);
      expect(again.results.items.every((i) => !i.isNew)).toBe(true);
      expect(await totals()).toEqual({ ...before, results: before.results + 2 });
    });

    it("asocia resultados aunque el original lo hubiera guardado otra ejecución", async () => {
      // Una importación anterior (búsqueda fija) guardó los originales.
      const legacy = await runImport({ rows });
      const [record] = await db
        .select({ runId: sourceRecords.searchRunId })
        .from(sourceRecords)
        .where(eq(sourceRecords.externalId, "630010000301"));
      expect(record?.runId).toBe(legacy.run.id);

      const s = await search({ keyword: "medico", departmentCode: "63" }, rows);
      expect(s.run.stats).toMatchObject({ recordsNew: 0, companiesMatched: 1 });
      expect(names(s)).toEqual(["CENTRO MEDICO GAMMA SAS"]);
      // El original sigue apuntando a la primera ejecución: los resultados no dependen de él.
      const [after] = await db
        .select({ runId: sourceRecords.searchRunId })
        .from(sourceRecords)
        .where(eq(sourceRecords.externalId, "630010000301"));
      expect(after?.runId).toBe(legacy.run.id);
    });

    it("filtra por la sede: muestra solo las sedes que coinciden y no toca la ciudad de la empresa", async () => {
      // Misma empresa (mismo NIT) con sedes en Armenia y Calarcá.
      const sameNit = { numeroidentificacion: "900000077", codigoprestador: "6300100077" };
      const two = [
        armenia("630010007701", { ...sameNit, nombresede: "ODONTOLOGIA ARMENIA" }),
        armenia("631300007702", {
          ...sameNit,
          municipiosede: "63130",
          municipiosededesc: "CALARCA",
          nombresede: "ODONTOLOGIA CALARCA",
        }),
      ];
      const r = await search(
        { keyword: "odontologia", departmentCode: "63", municipalityCode: "63130" },
        two,
      );
      expect(r.results.total).toBe(1);
      const [item] = r.results.items;
      expect(item?.matchedSites.map((s) => s.city)).toEqual(["CALARCA"]);
      // La ciudad de la empresa es la del prestador (Armenia), no la de la búsqueda.
      expect(item?.city).toBe("ARMENIA");
      // Solo los contactos de la sede coincidente (y los de la empresa).
      expect(item?.contacts.map((c) => c.value)).toEqual(["631300007702@ejemplo.test"]);
      // La otra sede no se incorporó en esta búsqueda.
      expect((await totals()).sites).toBe(1);
    });

    describe("ámbito de los contactos en los resultados", () => {
      // Empresa con sede A (Armenia) y sede B (Calarcá), y otra empresa C en Calarcá.
      const empresa = { numeroidentificacion: "900000055", codigoprestador: "6300100055" };
      const sedeA = armenia("630010005501", {
        ...empresa,
        nombresede: "ODONTOLOGIA SEDE A",
        // general@ es del prestador y además se publica como correo de la sede A.
        email_prestador: "general@ejemplo.test",
        email_sede: "general@ejemplo.test, sedea@ejemplo.test",
        t_lefonosede: "3000000303",
      });
      const sedeB = armenia("631300005502", {
        ...empresa,
        municipiosede: "63130",
        municipiosededesc: "CALARCA",
        nombresede: "ODONTOLOGIA SEDE B",
        // El registro de B no repite el correo general: su ámbito viene del de A.
        email_prestador: null,
        email_sede: "sedeb@ejemplo.test",
        t_lefonosede: "3000000303", // publicado en ambas sedes
      });
      const otra = armenia("631300006601", {
        municipiosede: "63130",
        municipiosededesc: "CALARCA",
        nombreprestador: "ODONTOLOGIA OTRA SAS",
        email_prestador: "otra-general@ejemplo.test",
        email_sede: "otra@ejemplo.test",
      });
      type Item = Awaited<ReturnType<typeof search>>["results"]["items"][number];
      const ours = (r: Awaited<ReturnType<typeof search>>) =>
        r.results.items.find((i) => i.nit === "900000055") as Item;
      const view = (item: Item) =>
        item.contacts
          .map((c) => ({
            value: c.valueNormalized,
            companyWide: c.companyWide,
            sites: c.siteIds.map((id) => item.matchedSites.find((s) => s.id === id)?.externalId),
          }))
          .sort((a, b) => a.value.localeCompare(b.value));

      it("muestra el contacto general aunque solo esté vinculado a una sede que no coincidió", async () => {
        // 1. Se incorporan ambas sedes y la otra empresa.
        await runImport({ rows: [sedeA, sedeB, otra] });
        const [general] = await db
          .select({ id: contactPoints.id })
          .from(contactPoints)
          .where(eq(contactPoints.valueNormalized, "general@ejemplo.test"));
        const linksBefore = await db
          .select({ site: companySites.externalId })
          .from(contactPointSites)
          .innerJoin(companySites, eq(companySites.id, contactPointSites.siteId))
          .where(eq(contactPointSites.contactPointId, general?.id as string));
        expect(linksBefore).toEqual([{ site: "630010005501" }]);

        // 2. Búsqueda que solo encuentra la sede B (y la otra empresa).
        const r = await search(
          { keyword: "odontologia", departmentCode: "63", municipalityCode: "63130" },
          [sedeA, sedeB, otra],
        );
        const before = await totals();
        const item = ours(r);
        expect(item.matchedSites.map((s) => s.externalId)).toEqual(["631300005502"]);
        expect(view(item)).toEqual([
          { value: "+573000000303", companyWide: false, sites: ["631300005502"] },
          // Aparece (una vez) aunque su único vínculo sea con A; no se le añade la sede A.
          { value: "general@ejemplo.test", companyWide: true, sites: [] },
          { value: "sedeb@ejemplo.test", companyWide: false, sites: ["631300005502"] },
        ]);
        // El exclusivo de A no aparece; nada de la otra empresa se mezcla.
        const values = item.contacts.map((c) => c.valueNormalized);
        expect(values).not.toContain("sedea@ejemplo.test");
        expect(values).not.toContain("otra@ejemplo.test");
        expect(new Set(item.contacts.map((c) => c.id)).size).toBe(item.contacts.length);
        const otherItem = r.results.items.find((i) => i.nit !== "900000055");
        expect(otherItem?.contacts.map((c) => c.valueNormalized).sort()).toEqual([
          "otra-general@ejemplo.test",
          "otra@ejemplo.test",
        ]);

        // 3. El vínculo con A y la procedencia (ambos ámbitos) se conservan.
        const linksAfter = await db
          .select({ site: companySites.externalId })
          .from(contactPointSites)
          .innerJoin(companySites, eq(companySites.id, contactPointSites.siteId))
          .where(eq(contactPointSites.contactPointId, general?.id as string));
        expect(linksAfter).toEqual(linksBefore);
        const prov = await db
          .select({ field: dataProvenance.field, scope: dataProvenance.scope })
          .from(dataProvenance)
          .where(eq(dataProvenance.entityId, general?.id as string))
          .orderBy(dataProvenance.field);
        expect(prov).toEqual([
          { field: "email_prestador", scope: "company" },
          { field: "email_sede", scope: "site" },
        ]);

        // 4. Consultar no crea ni modifica nada; repetir la búsqueda da lo mismo.
        await getSearchRunResults(db, r.run.id, 1, 50);
        expect(await totals()).toEqual(before);
        const again = await search(
          { keyword: "odontologia", departmentCode: "63", municipalityCode: "63130" },
          [sedeA, sedeB, otra],
        );
        expect(view(ours(again))).toEqual(view(item));
        expect(await totals()).toEqual({ ...before, results: before.results + 2 });
      });

      it("un contacto general que también es de una sede coincidente sale una sola vez, con ambos ámbitos", async () => {
        await runImport({ rows: [sedeA, sedeB, otra] });
        const r = await search(
          { keyword: "odontologia", departmentCode: "63", municipalityCode: "63001" },
          [sedeA, sedeB, otra],
        );
        expect(view(ours(r))).toEqual([
          { value: "+573000000303", companyWide: false, sites: ["630010005501"] },
          { value: "general@ejemplo.test", companyWide: true, sites: ["630010005501"] },
          { value: "sedea@ejemplo.test", companyWide: false, sites: ["630010005501"] },
        ]);
      });

      it("funciona con contactos ya incorporados tras la actualización de la migración", async () => {
        await runImport({ rows: [sedeA, sedeB, otra] });
        // Estado anterior a la migración: procedencia sin ámbito.
        await pool.query("update data_provenance set scope = null");
        // Sin evidencia de ámbito, un contacto vinculado solo a otra sede no se presume general.
        const without = await search(
          { keyword: "odontologia", departmentCode: "63", municipalityCode: "63130" },
          [sedeA, sedeB, otra],
        );
        await pool.query("update data_provenance set scope = null");
        expect(view(ours(without)).map((c) => c.value)).not.toContain("general@ejemplo.test");

        // La actualización de datos de la migración 0003, tal cual.
        const migration = readFileSync(
          fileURLToPath(
            new URL(
              "../../../../packages/db/migrations/0003_provenance_contact_scope.sql",
              import.meta.url,
            ),
          ),
          "utf8",
        );
        const backfill = migration.slice(migration.indexOf("UPDATE"));
        await pool.query(backfill);
        const fixed = await getSearchRunResults(db, without.run.id, 1, 50);
        const item = fixed.items.find((i) => i.nit === "900000055") as Item;
        expect(view(item).find((c) => c.value === "general@ejemplo.test")).toEqual({
          value: "general@ejemplo.test",
          companyWide: true,
          sites: [],
        });
        // Solo los campos de contacto de REPS reciben ámbito; el resto sigue sin él.
        const { rows } = await pool.query(
          "select entity_type, scope, count(*)::int n from data_provenance group by 1, 2 order by 1, 2",
        );
        expect(rows).toEqual([
          { entity_type: "company", scope: null, n: expect.any(Number) },
          { entity_type: "company_site", scope: null, n: expect.any(Number) },
          { entity_type: "contact_point", scope: "company", n: expect.any(Number) },
          { entity_type: "contact_point", scope: "site", n: expect.any(Number) },
        ]);
      });
    });

    it("encuentra una sede de una empresa domiciliada en otro departamento", async () => {
      const outside = armenia("630010008801", {
        nombreprestador: "ODONTOLOGIA NACIONAL SAS",
        municipio_prestador: "05001",
        municipioprestadordesc: "MEDELLIN",
        departamentoprestadordesc: "Antioquia",
      });
      const r = await search(
        { keyword: "odontologia", departmentCode: "63", municipalityCode: "63001" },
        [outside],
      );
      expect(r.results.items).toEqual([
        expect.objectContaining({
          legalName: "ODONTOLOGIA NACIONAL SAS",
          city: "MEDELLIN",
          department: "Antioquia",
          matchedSites: [expect.objectContaining({ city: "ARMENIA", department: "Quindío" })],
        }),
      ]);
    });

    it("una búsqueda sin coincidencias termina vacía, no fallida", async () => {
      const r = await search({ keyword: "inexistente", departmentCode: "63" }, rows);
      expect(r.error).toBeNull();
      expect(r.run.status).toBe("done");
      expect(r.run.stats).toMatchObject({
        recordsRead: 3,
        recordsMatched: 0,
        companiesMatched: 0,
        // Sin coincidencias, la fecha de corte de la fuente consultada sigue informándose.
        sourceCutoffAt: "2026-03-12T20:11:00.000Z",
      });
      expect(r.results).toMatchObject({ total: 0, items: [] });
      expect((await totals()).companies).toBe(0);
    });

    it("una fuente caída deja la búsqueda fallida y sin resultados", async () => {
      const plan = planSearch(
        searchCriteriaSchema.parse({ keyword: "odontolog", departmentCode: "63" }),
      );
      const [created] = await db
        .insert(searchRuns)
        .values({ adapter: plan.adapter, query: plan.query })
        .returning();
      const { run } = await runImport(
        { rows, failAt: { request: 2, status: 503 } },
        { runId: created?.id as string, job: attempt(2) },
      );
      expect(run.status).toBe("failed");
      expect((await getSearchRunResults(db, run.id, 1, 50)).total).toBe(0);
      expect(await totals()).toMatchObject({ companies: 0, results: 0 });
    });

    it("lista también las ejecuciones de la búsqueda fija anterior", async () => {
      const legacy = await runImport({ rows });
      const s = await search({ keyword: "medico", departmentCode: "63" }, rows);
      const list = (await listSearchRuns({ db, queue: noQueue }, 10)).map(toSearchRunDto);
      expect(list.map((r) => r.id)).toEqual([s.run.id, legacy.run.id]);
      expect(list[1]).toMatchObject({
        hasResults: false,
        criteria: { legacy: true, keyword: null, departmentCode: "63" },
      });
      expect(list[0]).toMatchObject({
        hasResults: true,
        sources: [{ key: "reps", name: "REPS (datos.gov.co)" }],
        criteria: { legacy: false, keyword: "medico" },
      });
    });
  });

  describe("creación y encolado", () => {
    let queue: Queue;
    beforeAll(async () => {
      queue = createQueue(TEST_DATABASE_URL as string);
      await queue.start();
    });
    afterAll(async () => {
      await queue?.stop();
    });

    it("crea la ejecución y su job juntos, y no duplica una búsqueda activa", async () => {
      const first = await createSearchRun({ db, pool, queue }, CRITERIA, USER_ID);
      expect(first.created).toBe(true);
      expect(first.run.jobId).toBeTruthy();
      expect(await queue.getJobState(QUEUES.importDataset, first.run.jobId as string)).toBe(
        "created",
      );
      const second = await createSearchRun({ db, pool, queue }, CRITERIA, USER_ID);
      expect(second).toMatchObject({ created: false, run: { id: first.run.id } });
      // Sin worker, sigue en cola: no se finge progreso.
      const status = await getSearchRun({ db, queue }, first.run.id);
      expect(status?.status).toBe("queued");
    });

    it("solicitudes equivalentes comparten la ejecución activa; criterios distintos no", async () => {
      const deps = { db, pool, queue };
      const parse = (v: unknown) => searchCriteriaSchema.parse(v);
      const first = await createSearchRun(
        deps,
        parse({
          keyword: " Clínica   Odontológica ",
          departmentCode: "63",
          municipalityCode: "63001",
        }),
        USER_ID,
      );
      const same = await createSearchRun(
        deps,
        parse({ keyword: "odontologica CLINICA", departmentCode: "63", municipalityCode: "63001" }),
        USER_ID,
      );
      expect(first.created).toBe(true);
      expect(same).toMatchObject({ created: false, run: { id: first.run.id } });

      const otherPlace = await createSearchRun(
        deps,
        parse({ keyword: "clinica odontologica", departmentCode: "63" }),
        USER_ID,
      );
      const otherWord = await createSearchRun(
        deps,
        parse({ keyword: "clinica", departmentCode: "63", municipalityCode: "63001" }),
        USER_ID,
      );
      expect(otherPlace.created).toBe(true);
      expect(otherWord.created).toBe(true);
      expect(new Set([first.run.id, otherPlace.run.id, otherWord.run.id]).size).toBe(3);
      // Cada una con su job en la cola.
      for (const r of [first, otherPlace, otherWord]) {
        expect(await queue.getJobState(QUEUES.importDataset, r.run.jobId as string)).toBe(
          "created",
        );
      }
    });

    it("solicitudes simultáneas crean una sola ejecución", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => createSearchRun({ db, pool, queue }, CRITERIA, USER_ID)),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
      expect((await db.select({ n: count() }).from(searchRuns))[0]?.n).toBe(1);
    });

    it("si encolar falla, no queda una ejecución huérfana ni un job suelto", async () => {
      let sentId: string | null = null;
      const failingQueue: Queue = {
        ...queue,
        async send(name, data, options) {
          sentId = await queue.send(name, data, options);
          throw new Error("fallo después de encolar");
        },
      };
      await expect(
        createSearchRun({ db, pool, queue: failingQueue }, CRITERIA, USER_ID),
      ).rejects.toThrow("fallo después de encolar");
      expect((await db.select({ n: count() }).from(searchRuns))[0]?.n).toBe(0);
      expect(sentId).toBeTruthy();
      expect(await queue.getJobState(QUEUES.importDataset, sentId as unknown as string)).toBeNull();
    });

    it("marca como fallida una ejecución cuyo job terminó sin cerrarla", async () => {
      const { run } = await createSearchRun({ db, pool, queue }, CRITERIA, USER_ID);
      await db.update(searchRuns).set({ status: "running" }).where(eq(searchRuns.id, run.id));
      // El job terminó (cancelado, vencido sin reintentos o borrado) sin cerrar la ejecución.
      await queue.boss.cancel(QUEUES.importDataset, run.jobId as string);
      const status = await getSearchRun({ db, queue }, run.id);
      expect(status?.status).toBe("failed");
      expect(status?.error).toMatch(/se interrumpió/);
      // Y ya se puede lanzar otra.
      const next = await createSearchRun({ db, pool, queue }, CRITERIA, USER_ID);
      expect(next.created).toBe(true);
    });
  });
});
