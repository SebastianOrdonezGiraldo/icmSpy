import { describe, expect, it } from "vitest";
import {
  fakeSources,
  IPS,
  repsRow,
  SERVICE_METADATA,
  serviceRow,
} from "../../../test/reps-fixtures";
import { SourceHttpError, SourceQueryError, SourceSchemaError } from "../errors";
import type { RawRecord, SearchQuery } from "../ports/source-adapter";
import { createRepsAdapter, parseRepsRow, resolveRepsRow } from "./reps";
import { createServiceSourceAdapter, SERVICE_DATASETS, siteCodeOf } from "./reps-services";

const CUND = SERVICE_DATASETS[0] as (typeof SERVICE_DATASETS)[number];
const QUERY: SearchQuery = { departmentCodes: ["25"], serviceCodes: ["739"] };

async function collect(adapter: ReturnType<typeof createServiceSourceAdapter>, query = QUERY) {
  const out: RawRecord[] = [];
  if (!adapter.discover) throw new Error("sin discover");
  for await (const r of adapter.discover(query)) out.push(r);
  return out;
}

describe("fuente de servicios habilitados (j93s-yemu)", () => {
  it("arma el código de sede del REPS con el número de sede de dos dígitos", () => {
    expect(siteCodeOf("2500100094", "1")).toBe("250010009401");
    expect(siteCodeOf("2500100094", "19")).toBe("250010009419");
    expect(siteCodeOf("25001", "1")).toBeNull();
    expect(siteCodeOf("2500100094", "123")).toBeNull();
  });

  it("interpreta servicio, estado, modalidades, naturaleza y corte", async () => {
    const api = fakeSources({ reps: [], services: [serviceRow("250010010001")] });
    const adapter = createServiceSourceAdapter(CUND, { fetch: api.fetch });
    const [record] = await collect(adapter);
    expect(record?.externalId).toBe("250010010001|739");
    expect(adapter.resolveService?.(record as RawRecord)).toEqual({
      siteCode: "250010010001",
      serviceCode: "739",
      serviceName: "FISIOTERAPIA",
      status: "SI",
      modalities: ["ambulatorio", "domiciliario"],
      personKind: "juridica",
      sourceCutoffAt: new Date("2022-06-29T17:39:00.000Z"),
      sourceCutoffRaw: "Fecha corte REPS: Jun 29 2022 12:39PM",
    });
    // Consulta: códigos numéricos sin comillas y orden estable por fila.
    const pageReq = api.requests.find((u) => u.searchParams.has("$offset"));
    expect(pageReq?.searchParams.get("$where")).toBe("serv_codigo in (739)");
    expect(pageReq?.searchParams.get("$order")).toBe(":id");
    expect(record?.url).toContain("codigo_habilitacion=2500100100");
  });

  it("lee todas las páginas", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => serviceRow(`25001001000${i}`));
    const api = fakeSources({ reps: [], services: rows });
    const records = await collect(
      createServiceSourceAdapter(CUND, { fetch: api.fetch, pageSize: 2 }),
    );
    expect(records).toHaveLength(5);
    expect(api.requests.filter((u) => u.searchParams.has("$offset"))).toHaveLength(3);
  });

  it("rechaza un departamento que no cubre, antes de consultar", async () => {
    const api = fakeSources({ reps: [] });
    await expect(
      collect(createServiceSourceAdapter(CUND, { fetch: api.fetch }), {
        departmentCodes: ["05"],
        serviceCodes: ["739"],
      }),
    ).rejects.toBeInstanceOf(SourceQueryError);
    expect(api.requests).toHaveLength(0);
  });

  it("detecta cambios de estructura y fallos HTTP", async () => {
    const broken = fakeSources({
      reps: [],
      services: [serviceRow("250010010001", { serv_codigo: "x" })],
    });
    await expect(
      collect(createServiceSourceAdapter(CUND, { fetch: broken.fetch })),
    ).rejects.toBeInstanceOf(SourceSchemaError);
    const down = fakeSources({ reps: [], failServices: 503 });
    const err = await collect(createServiceSourceAdapter(CUND, { fetch: down.fetch })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SourceHttpError);
    expect(err.retryable).toBe(true);
    expect(SERVICE_METADATA.columns.length).toBeGreaterThan(0);
  });
});

describe("REPS: clases de prestador e identificación", () => {
  it("consulta varias clases y no trata a un profesional como IPS", async () => {
    const api = fakeSources({ reps: [] });
    const reps = createRepsAdapter({ fetch: api.fetch });
    if (!reps.discover) throw new Error("sin discover");
    for await (const _ of reps.discover({
      departmentCodes: ["25"],
      providerClasses: ["ips", "profesional"],
    })) {
      // sin filas
    }
    const where = api.requests
      .find((u) => u.searchParams.has("$offset"))
      ?.searchParams.get("$where");
    expect(where).toBe(
      `(starts_with(municipiosede, '25')) AND claseprestador in ('${IPS}', 'Profesional Independiente')`,
    );

    const pro = resolveRepsRow(
      parseRepsRow(
        repsRow({
          claseprestador: "Profesional Independiente",
          tipoid: "CC",
          numeroidentificacion: "10.000.001",
          nombreprestador: "PERSONA EJEMPLO",
        }),
        "#1",
      ),
    );
    expect(pro.company).toMatchObject({
      nit: null,
      identificationType: "CC",
      identificationNumber: "10000001",
      companyType: "profesional_independiente",
      providerClass: "Profesional Independiente",
      personKind: null,
    });
  });

  it("consulta sedes por código para saber cuáles existen y dónde", async () => {
    const api = fakeSources({
      reps: [repsRow({ codigohabilitacionsede: "250010010001", municipiosede: "25001" })],
      repsElsewhere: [repsRow({ codigohabilitacionsede: "050010010001", municipiosede: "05001" })],
    });
    const reps = createRepsAdapter({ fetch: api.fetch });
    const found = await reps.lookupSiteLocations?.([
      "250010010001",
      "050010010001",
      "999999999999",
    ]);
    expect(found).toEqual(
      new Map([
        ["250010010001", "25001"],
        ["050010010001", "05001"],
      ]),
    );
  });
});
