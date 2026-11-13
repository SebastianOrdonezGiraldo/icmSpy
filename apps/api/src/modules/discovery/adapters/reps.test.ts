import { describe, expect, it } from "vitest";
import { CUTOFF, fakeSocrata, IPS, REPS_METADATA, repsRow } from "../../../test/reps-fixtures";
import {
  SourceConsistencyError,
  SourceHttpError,
  SourceQueryError,
  SourceSchemaError,
  SourceUnavailableError,
} from "../errors";
import type { DiscoverHooks, RawRecord, SearchQuery } from "../ports/source-adapter";
import { createRepsAdapter, parseRepsCutoff, parseRepsRow, resolveRepsRow } from "./reps";

const QUINDIO: SearchQuery = { departmentCodes: ["63"], providerClass: "ips" };

async function collect(
  adapter: ReturnType<typeof createRepsAdapter>,
  query: SearchQuery = QUINDIO,
  hooks?: DiscoverHooks,
) {
  const out: RawRecord[] = [];
  if (!adapter.discover) throw new Error("sin discover");
  for await (const r of adapter.discover(query, hooks)) out.push(r);
  return out;
}

function rows(n: number) {
  return Array.from({ length: n }, (_, i) =>
    repsRow({ codigohabilitacionsede: `63001000010${i}`, nombresede: `SEDE ${i}` }),
  );
}

describe("mapeo de REPS", () => {
  it("traduce una fila a empresa, sede y contactos con su campo de origen", () => {
    const r = resolveRepsRow(parseRepsRow(repsRow(), "#1"));
    expect(r.company).toEqual({
      nit: "900000001",
      providerCode: "6300100001",
      legalName: "CLINICA EJEMPLO DEL QUINDIO S.A.S.",
      companyType: "ips",
      cityCode: "63001",
      city: "ARMENIA",
      department: "Quindío",
    });
    expect(r.site).toEqual({
      externalId: "630010000101",
      name: "CLINICA EJEMPLO SEDE CENTRO",
      address: "CALLE 1 # 2-3",
      cityCode: "63001",
      city: "ARMENIA",
      department: "Quindío",
    });
    expect(r.contacts).toEqual([
      {
        kind: "email",
        value: "info@ejemplo.test",
        normalized: "info@ejemplo.test",
        scope: "site",
        field: "email_sede",
      },
      {
        kind: "phone",
        value: "7000002",
        normalized: "+576067000002",
        scope: "site",
        field: "t_lefonosede",
      },
      {
        kind: "phone",
        value: "3000000003",
        normalized: "+573000000003",
        scope: "site",
        field: "t_lefonosede",
      },
      {
        kind: "email",
        value: "gerencia@ejemplo.test",
        normalized: "gerencia@ejemplo.test",
        scope: "company",
        field: "email_prestador",
      },
      {
        kind: "phone",
        value: "6067000001",
        normalized: "+576067000001",
        scope: "company",
        field: "telefonoprestador",
      },
    ]);
    // Se conserva el texto publicado, con los espacios repetidos colapsados.
    expect(r.sourceCutoffRaw).toBe(CUTOFF.replace(/\s+/g, " "));
    expect(r.sourceCutoffAt?.toISOString()).toBe("2026-03-12T20:11:00.000Z");
  });

  it("no trata como NIT una identificación de otro tipo", () => {
    const r = resolveRepsRow(
      parseRepsRow(repsRow({ tipoid: "CC", numeroidentificacion: "10000001" }), "#1"),
    );
    expect(r.company.nit).toBeNull();
    expect(r.company.providerCode).toBe("6300100001");
  });

  it("no inventa sitio web: REPS no lo publica y no se deriva del correo", () => {
    const r = resolveRepsRow(
      parseRepsRow(repsRow({ email_sede: "a@clinicaejemplo.com.co" }), "#1"),
    );
    expect(r.contacts.some((c) => c.kind === "website")).toBe(false);
  });

  it("separa campos con varios correos y teléfonos y marca los ininterpretables", () => {
    const r = resolveRepsRow(
      parseRepsRow(
        repsRow({
          email_sede: "uno@ejemplo.test, dos@ejemplo.test  / no-es-correo",
          t_lefonosede: "(6)7000005 - 3000000006-3000000007, 123",
          email_prestador: null,
          telefonoprestador: null,
        }),
        "#1",
      ),
    );
    expect(r.contacts.map((c) => [c.value, c.normalized])).toEqual([
      ["uno@ejemplo.test", "uno@ejemplo.test"],
      ["dos@ejemplo.test", "dos@ejemplo.test"],
      ["no-es-correo", null],
      ["(6)7000005", "+576067000005"],
      ["3000000006", "+573000000006"],
      ["3000000007", "+573000000007"],
      ["123", null],
    ]);
  });

  it("usa la ubicación de la sede o del prestador según el campo del teléfono", () => {
    // Sede en Quindío (indicativo 6) y prestador registrado en Antioquia (05001).
    const r = resolveRepsRow(
      parseRepsRow(
        repsRow({
          municipio_prestador: "05001",
          t_lefonosede: "(096) 7000005",
          telefonoprestador: "967000006",
          email_sede: null,
          email_prestador: null,
        }),
        "#1",
      ),
    );
    expect(r.contacts).toEqual([
      {
        kind: "phone",
        value: "(096) 7000005",
        normalized: "+576067000005",
        scope: "site",
        field: "t_lefonosede",
      },
      // Para el prestador no se conoce el indicativo: no se usa el de la sede.
      {
        kind: "phone",
        value: "967000006",
        normalized: null,
        scope: "company",
        field: "telefonoprestador",
      },
    ]);
  });

  it("interpreta la fecha de corte y devuelve null si cambia el formato", () => {
    expect(parseRepsCutoff("Fecha corte REPS: Dec 1 2025 11:05AM")?.toISOString()).toBe(
      "2025-12-01T16:05:00.000Z",
    );
    expect(parseRepsCutoff("corte desconocido")).toBeNull();
  });

  it("rechaza filas con estructura distinta sin revelar valores", () => {
    const bad = repsRow({ municipiosede: undefined, email_sede: "secreto@ejemplo.test" });
    expect(() => parseRepsRow(bad, "#7")).toThrow(SourceSchemaError);
    expect(() => parseRepsRow(bad, "#7")).toThrow(/municipiosede/);
    try {
      parseRepsRow(bad, "#7");
    } catch (err) {
      expect(String(err)).not.toContain("secreto");
    }
  });
});

describe("consulta a REPS", () => {
  it("lee todas las páginas con orden estable y se detiene en la página corta", async () => {
    const api = fakeSocrata({ rows: rows(5) });
    const pages: number[] = [];
    const adapter = createRepsAdapter({ fetch: api.fetch, pageSize: 2 });
    const records = await collect(adapter, QUINDIO, {
      onPage: (p) => {
        pages.push(p.recordsRead);
      },
    });
    expect(records.map((r) => r.externalId)).toEqual(rows(5).map((r) => r.codigohabilitacionsede));
    expect(pages).toEqual([2, 4, 5]);
    const pageRequests = api.requests.filter((u) => u.searchParams.has("$offset"));
    expect(pageRequests.map((u) => u.searchParams.get("$offset"))).toEqual(["0", "2", "4"]);
    for (const u of pageRequests) {
      expect(u.origin).toBe("https://www.datos.gov.co");
      expect(u.searchParams.get("$order")).toBe("codigohabilitacionsede");
      expect(u.searchParams.get("$where")).toBe(
        `(starts_with(municipiosede, '63')) AND claseprestador = '${IPS}'`,
      );
    }
    expect(records[0]?.url).toBe(
      "https://www.datos.gov.co/resource/c36g-9fc2.json?codigohabilitacionsede=630010000100",
    );
  });

  it("termina cuando el total es múltiplo exacto del tamaño de página", async () => {
    const api = fakeSocrata({ rows: rows(4) });
    const records = await collect(createRepsAdapter({ fetch: api.fetch, pageSize: 2 }));
    expect(records).toHaveLength(4);
    expect(api.requests.filter((u) => u.searchParams.has("$offset"))).toHaveLength(3);
  });

  it("distingue un resultado vacío de un fallo", async () => {
    const api = fakeSocrata({ rows: [] });
    const snapshots: number[] = [];
    const records = await collect(createRepsAdapter({ fetch: api.fetch }), QUINDIO, {
      onSnapshot: (s) => {
        snapshots.push(s.expectedCount);
      },
    });
    expect(records).toEqual([]);
    expect(snapshots).toEqual([0]);
  });

  it("descarta filas fuera del departamento o de otra clase de prestador", async () => {
    const api = fakeSocrata({
      rows: [
        repsRow(),
        repsRow({ codigohabilitacionsede: "660010000101", municipiosede: "66001" }),
        repsRow({
          codigohabilitacionsede: "630010000199",
          claseprestador: "Profesional Independiente",
        }),
      ],
    });
    const excluded: string[] = [];
    const records = await collect(createRepsAdapter({ fetch: api.fetch }), QUINDIO, {
      onExcluded: (_r, reason) => excluded.push(reason),
    });
    expect(records.map((r) => r.externalId)).toEqual(["630010000101"]);
    expect(excluded).toEqual(["departamento", "clase de prestador"]);
  });

  it("falla con error HTTP explícito; 5xx se puede reintentar, 4xx no", async () => {
    const server = fakeSocrata({ rows: rows(3), failAt: { request: 2, status: 503 } });
    const err = await collect(createRepsAdapter({ fetch: server.fetch })).catch((e) => e);
    expect(err).toBeInstanceOf(SourceHttpError);
    expect(err.retryable).toBe(true);

    const client = fakeSocrata({
      rows: rows(3),
      failAt: { request: 1, status: 400, body: { message: "No such column: x" } },
    });
    const err2 = await collect(createRepsAdapter({ fetch: client.fetch })).catch((e) => e);
    expect(err2).toBeInstanceOf(SourceHttpError);
    expect(err2.retryable).toBe(false);
    expect(err2.message).toContain("No such column");
  });

  it("detecta que falta una columna o cambió su tipo", async () => {
    const missing = {
      ...REPS_METADATA,
      columns: REPS_METADATA.columns.filter((c) => c.fieldName !== "email_sede"),
    };
    const api = fakeSocrata({ rows: rows(1), metadata: missing });
    await expect(collect(createRepsAdapter({ fetch: api.fetch }))).rejects.toThrow(/email_sede/);

    const retyped = {
      ...REPS_METADATA,
      columns: REPS_METADATA.columns.map((c) =>
        c.fieldName === "numeroidentificacion" ? { ...c, dataTypeName: "text" } : c,
      ),
    };
    const api2 = fakeSocrata({ rows: rows(1), metadata: retyped });
    await expect(collect(createRepsAdapter({ fetch: api2.fetch }))).rejects.toBeInstanceOf(
      SourceSchemaError,
    );
  });

  it("no completa la lectura si una fila cambió de estructura", async () => {
    const api = fakeSocrata({
      rows: [repsRow(), repsRow({ codigohabilitacionsede: 12 as never })],
    });
    await expect(collect(createRepsAdapter({ fetch: api.fetch }))).rejects.toThrow(
      /registro #2, campo "codigohabilitacionsede"/,
    );
  });

  it("falla si se leen menos registros de los anunciados", async () => {
    const api = fakeSocrata({ rows: rows(3), count: 5 });
    await expect(
      collect(createRepsAdapter({ fetch: api.fetch, pageSize: 2 })),
    ).rejects.toBeInstanceOf(SourceConsistencyError);
  });

  it("falla si la fuente repite una sede entre páginas", async () => {
    const api = fakeSocrata({
      rows: [repsRow(), repsRow(), repsRow({ codigohabilitacionsede: "1" })],
    });
    await expect(
      collect(createRepsAdapter({ fetch: api.fetch, pageSize: 2 })),
    ).rejects.toBeInstanceOf(SourceConsistencyError);
  });

  it("corta por tiempo de espera", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const err = await collect(createRepsAdapter({ fetch: hanging, timeoutMs: 20 })).catch((e) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(err.message).toContain("no respondió");
  });

  it("rechaza consultas fuera de lo admitido en vez de leer una muestra", async () => {
    const adapter = createRepsAdapter({ fetch: fakeSocrata({ rows: [] }).fetch });
    await expect(collect(adapter, { ...QUINDIO, limit: 10 })).rejects.toBeInstanceOf(
      SourceQueryError,
    );
    await expect(
      collect(adapter, { departmentCodes: ["6'3"], providerClass: "ips" }),
    ).rejects.toBeInstanceOf(SourceQueryError);
    await expect(
      collect(adapter, { departmentCodes: ["63"], providerClass: "Profesional Independiente" }),
    ).rejects.toBeInstanceOf(SourceQueryError);
  });
});

describe("búsqueda configurable en REPS", () => {
  const odonto = (overrides: Parameters<typeof repsRow>[0] = {}) =>
    repsRow({ nombreprestador: "IPS EJEMPLO SAS", nombresede: "SEDE CENTRO", ...overrides });

  it("filtra en la API por el municipio de la sede", async () => {
    const api = fakeSocrata({ rows: [] });
    await collect(createRepsAdapter({ fetch: api.fetch }), {
      ...QUINDIO,
      municipalityCodes: ["63001"],
      keywords: ["odontologica"],
    });
    const where = api.requests
      .find((u) => u.searchParams.has("$offset"))
      ?.searchParams.get("$where");
    expect(where).toBe(`(municipiosede = '63001') AND claseprestador = '${IPS}'`);
    // La palabra clave no viaja a la fuente: se aplica al leer.
    expect(where).not.toContain("odontolog");
  });

  it("rechaza un municipio de otro departamento antes de consultar", async () => {
    const api = fakeSocrata({ rows: [] });
    await expect(
      collect(createRepsAdapter({ fetch: api.fetch }), {
        ...QUINDIO,
        municipalityCodes: ["05001"],
      }),
    ).rejects.toBeInstanceOf(SourceQueryError);
    expect(api.requests).toHaveLength(0);
  });

  it("aplica la palabra clave al nombre del prestador o de la sede, sin tildes", async () => {
    const rows = [
      odonto({
        codigohabilitacionsede: "630010000101",
        nombreprestador: "CLINICA ODONTOLÓGICA SAS",
      }),
      odonto({ codigohabilitacionsede: "630010000102", nombresede: "SEDE ODONTOLOGICA NORTE" }),
      odonto({ codigohabilitacionsede: "630010000103" }),
    ];
    const api = fakeSocrata({ rows });
    let notMatching = 0;
    const records = await collect(
      createRepsAdapter({ fetch: api.fetch }),
      { ...QUINDIO, keywords: ["odontologica"] },
      { onNotMatching: () => notMatching++ },
    );
    expect(records.map((r) => r.externalId)).toEqual(["630010000101", "630010000102"]);
    expect(notMatching).toBe(1);
  });

  it("lee todas las páginas aunque filtre por palabra clave", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      odonto({
        codigohabilitacionsede: `63001000020${i}`,
        nombresede: i % 2 === 0 ? "SEDE ODONTOLOGIA" : "SEDE CENTRO",
      }),
    );
    const api = fakeSocrata({ rows });
    const records = await collect(createRepsAdapter({ fetch: api.fetch, pageSize: 2 }), {
      ...QUINDIO,
      keywords: ["odontologia"],
    });
    expect(records).toHaveLength(3);
    expect(api.requests.filter((u) => u.searchParams.has("$offset"))).toHaveLength(3);
  });

  it("descarta lo que la fuente devuelva de otro municipio", async () => {
    const api = fakeSocrata({
      rows: [odonto(), odonto({ codigohabilitacionsede: "631300000101", municipiosede: "63130" })],
    });
    const excluded: string[] = [];
    const records = await collect(
      createRepsAdapter({ fetch: api.fetch }),
      { ...QUINDIO, municipalityCodes: ["63001"] },
      { onExcluded: (_r, reason) => excluded.push(reason) },
    );
    expect(records.map((r) => r.externalId)).toEqual(["630010000101"]);
    expect(excluded).toEqual(["municipio"]);
  });
});

describe("contexto telefónico fuera de Quindío", () => {
  const phones = (overrides: Parameters<typeof repsRow>[0]) =>
    resolveRepsRow(
      parseRepsRow(repsRow({ email_sede: null, email_prestador: null, ...overrides }), "#1"),
    ).contacts.map((c) => [c.field, c.value, c.normalized]);

  it("usa el indicativo oficial del departamento de la sede", () => {
    // Antioquia (604), Bogotá (601), Atlántico (605), San Andrés (608).
    expect(
      phones({ municipiosede: "05001", t_lefonosede: "4440001", telefonoprestador: null }),
    ).toEqual([["t_lefonosede", "4440001", "+576044440001"]]);
    expect(
      phones({ municipiosede: "11001", t_lefonosede: "3330001", telefonoprestador: null }),
    ).toEqual([["t_lefonosede", "3330001", "+576013330001"]]);
    expect(
      phones({ municipiosede: "08001", t_lefonosede: "3600001", telefonoprestador: null }),
    ).toEqual([["t_lefonosede", "3600001", "+576053600001"]]);
    expect(
      phones({ municipiosede: "88001", t_lefonosede: "5120001", telefonoprestador: null }),
    ).toEqual([["t_lefonosede", "5120001", "+576085120001"]]);
  });

  it("no aplica 606 fuera del Eje Cafetero ni mezcla sede y prestador", () => {
    expect(
      phones({
        municipiosede: "05001",
        t_lefonosede: "(096) 7000001, (094) 4000001",
        municipio_prestador: "11001",
        telefonoprestador: "3330002",
      }),
    ).toEqual([
      // "(096)" escribe el indicativo 6, que no es el de Antioquia: no se interpreta.
      ["t_lefonosede", "(096) 7000001", null],
      ["t_lefonosede", "(094) 4000001", "+576044000001"],
      // Teléfono del prestador con el indicativo del prestador (Bogotá), no el de la sede.
      ["telefonoprestador", "3330002", "+576013330002"],
    ]);
  });

  it("sin departamento conocido conserva el descarte", () => {
    expect(
      phones({ municipiosede: "27086", t_lefonosede: "6700001", telefonoprestador: null }),
    ).toEqual([["t_lefonosede", "6700001", "+576046700001"]]);
    // Código que no corresponde a ningún departamento: sin indicativo, no se adivina.
    expect(
      phones({ municipiosede: "00001", t_lefonosede: "6700001", telefonoprestador: null }),
    ).toEqual([["t_lefonosede", "6700001", null]]);
  });
});
