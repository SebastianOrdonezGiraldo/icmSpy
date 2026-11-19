import {
  CONFIRMING_KINDS,
  EQUIVALENCES,
  RELATED,
  REPS_SERVICE_CATALOG,
  resolveServices,
  searchCriteriaSchema,
} from "@icmspy/shared";
import { describe, expect, it } from "vitest";
import type { SourceAdapter } from "../discovery/ports/source-adapter";
import { planSearch } from "./presets";

const view = (keyword: string) => resolveServices(keyword).map((s) => `${s.code}:${s.kind}`);

describe("resolución de conceptos con el catálogo oficial", () => {
  it("el catálogo incluye fisioterapia con el código 739", () => {
    expect(REPS_SERVICE_CATALOG).toContainEqual(["739", "FISIOTERAPIA"]);
    // Toda equivalencia y relación apunta a códigos que existen en el catálogo.
    const codes = new Set(REPS_SERVICE_CATALOG.map(([c]) => c));
    for (const rule of [...EQUIVALENCES, ...RELATED]) {
      for (const code of rule.codes) expect(codes.has(code)).toBe(true);
    }
  });

  it("coincidencia exacta, sin depender de mayúsculas ni tildes", () => {
    expect(view("fisioterapia")).toEqual(["739:exact"]);
    expect(view("FISIOTERAPIA")).toEqual(["739:exact"]);
    expect(view("Medicina General")).toEqual(["328:exact"]);
  });

  it("equivalencias documentadas: profesión y denominación alternativa", () => {
    expect(view("fisioterapeuta")).toEqual(["739:equivalent"]);
    expect(view("Fisioterapeutas")).toEqual(["739:equivalent"]);
    expect(view("terapia física")).toEqual(["739:equivalent"]);
    expect(view("dentista")).toEqual(["334:equivalent"]);
    expect(resolveServices("fisioterapeuta")[0]?.reason).toMatch(/Ley 528 de 1999/);
  });

  it("un concepto más amplio se marca como relacionado, no como confirmación", () => {
    const r = resolveServices("rehabilitación");
    // Servicios cuyo nombre empieza por la palabra: evidencia directa.
    expect(r.filter((s) => CONFIRMING_KINDS.includes(s.kind)).map((s) => s.code)).toEqual([
      "346",
      "347",
    ]);
    // Fisioterapia y otras terapias: solo relacionadas.
    expect(r.filter((s) => s.kind === "related").map((s) => s.code)).toEqual([
      "327",
      "728",
      "729",
      "739",
      "740",
    ]);
    expect(r.find((s) => s.code === "739")?.kind).toBe("related");
  });

  it("el nombre del servicio debe empezar por la palabra: un adjetivo no basta", () => {
    expect(view("odonto")).toEqual(["334:catalog", "396:catalog"]);
    // "clínica" y "odontológica" solo aparecen como calificativos en el catálogo.
    expect(view("clínica")).toEqual([]);
    expect(view("odontológica")).toEqual([]);
    // "terapia" no encuentra FISIOTERAPIA por contener la cadena.
    expect(view("terapia")).not.toContain("739:catalog");
  });

  it("una palabra fuera del catálogo no se convierte en ningún servicio", () => {
    expect(resolveServices("insumos médicos")).toEqual([]);
    expect(resolveServices("de la")).toEqual([]);
  });
});

describe("selección de fuentes según la palabra y el lugar", () => {
  const parse = (v: unknown) => searchCriteriaSchema.parse(v);

  it("con un servicio y un departamento cubierto, añade la fuente de servicios", () => {
    const plan = planSearch(parse({ keyword: "fisioterapia", departmentCode: "25" }));
    expect(plan.query.sources).toEqual(["reps", "reps-servicios-cundinamarca"]);
    expect(plan.query.serviceCodes).toEqual(["739"]);
  });

  it("sin fuente de servicios para el departamento, solo consulta prestadores", () => {
    const plan = planSearch(parse({ keyword: "fisioterapia", departmentCode: "05" }));
    expect(plan.query.services.map((s) => s.code)).toEqual(["739"]);
    expect(plan.query.sources).toEqual(["reps"]);
  });

  it("si la palabra no es un servicio, no consulta fuentes de servicios", () => {
    const plan = planSearch(parse({ keyword: "insumos", departmentCode: "25" }));
    expect(plan.query.services).toEqual([]);
    expect(plan.query.sources).toEqual(["reps"]);
  });

  it("nunca consulta una fuente de servicios desactivada", () => {
    const fake = (
      key: string,
      operational: boolean,
      role: "providers" | "services",
    ): SourceAdapter => ({
      key,
      name: key,
      legalBasis: "open_data",
      operational,
      role,
      serviceCoverage: { departmentCodes: ["25"] },
      capabilities: ["discover"],
      discover: async function* () {},
      resolve: () => {
        throw new Error("no usado");
      },
      resolveService: () => {
        throw new Error("no usado");
      },
    });
    const plan = planSearch(parse({ keyword: "fisioterapia", departmentCode: "25" }), [
      fake("reps", true, "providers"),
      fake("servicios-desactivada", false, "services"),
    ]);
    expect(plan.query.sources).toEqual(["reps"]);
  });
});
