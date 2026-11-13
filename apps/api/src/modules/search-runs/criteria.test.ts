import {
  foldText,
  keywordTerms,
  matchesKeyword,
  municipalityBelongsTo,
  searchCriteriaSchema,
} from "@icmspy/shared";
import { describe, expect, it } from "vitest";
import type { SourceAdapter } from "../discovery/ports/source-adapter";
import { criteriaOf, planSearch } from "./presets";

const parse = (input: unknown) => searchCriteriaSchema.safeParse(input);
const issues = (input: unknown) => {
  const r = parse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("palabra clave", () => {
  it("ignora mayúsculas, minúsculas, tildes y espacios repetidos", () => {
    expect(foldText("  Clínica   ODONTOLÓGICA  ")).toBe("clinica odontologica");
    expect(keywordTerms("Odontológica")).toEqual(["odontologica"]);
    expect(matchesKeyword(["odontologica"], ["CLINICA ODONTOLOGICA SAS"])).toBe(true);
    expect(matchesKeyword(["odontologica"], ["Clínica Odontológica"])).toBe(true);
  });

  it("varias palabras: todas, en cualquier orden, en el prestador o en la sede", () => {
    const terms = keywordTerms("salud oral");
    expect(terms).toEqual(["oral", "salud"]);
    expect(matchesKeyword(terms, ["IPS ORAL Y SALUD SAS"])).toBe(true);
    // Repartidas entre el nombre del prestador y el de la sede.
    expect(matchesKeyword(terms, ["IPS SALUD TOTAL", "SEDE ORAL CENTRO"])).toBe(true);
    // Falta una de las palabras.
    expect(matchesKeyword(terms, ["IPS SALUD TOTAL", "SEDE CENTRO"])).toBe(false);
    // No une el final de un nombre con el inicio del otro.
    expect(matchesKeyword(["totalsede"], ["IPS SALUD TOTAL", "SEDE CENTRO"])).toBe(false);
  });

  it("coincide por contenido: una raíz encuentra las variantes", () => {
    expect(matchesKeyword(["odonto"], ["ODONTOLOGIA INTEGRAL"])).toBe(true);
    expect(matchesKeyword(["odonto"], ["SERVICIOS ODONTOLÓGICOS"])).toBe(true);
  });

  it("trata los caracteres especiales como texto literal", () => {
    expect(matchesKeyword(keywordTerms("s.a.s"), ["CLINICA ABC S.A.S"])).toBe(true);
    expect(matchesKeyword(keywordTerms("s.a.s"), ["CLINICA ABC SAS"])).toBe(false);
    // Ni comodines SQL ni expresiones regulares.
    expect(matchesKeyword(keywordTerms("%"), ["CLINICA ABC"])).toBe(false);
    expect(matchesKeyword(keywordTerms("a_c"), ["ABC"])).toBe(false);
    expect(matchesKeyword(keywordTerms(".*"), ["CLINICA ABC"])).toBe(false);
    expect(matchesKeyword(keywordTerms("(sede"), ["CLINICA (SEDE NORTE)"])).toBe(true);
  });

  it("forma canónica: términos únicos y ordenados", () => {
    expect(keywordTerms("Salud  ORAL salud")).toEqual(["oral", "salud"]);
    expect(keywordTerms("oral salud")).toEqual(keywordTerms("SALUD Óral"));
  });
});

describe("criterios de búsqueda", () => {
  it("acepta palabra clave, departamento y municipio del departamento", () => {
    expect(
      parse({ keyword: " odontológica ", departmentCode: "63", municipalityCode: "63001" }),
    ).toMatchObject({
      success: true,
      data: { keyword: "odontológica", departmentCode: "63", municipalityCode: "63001" },
    });
    // Municipio opcional.
    expect(parse({ keyword: "clinica", departmentCode: "63" })).toMatchObject({
      success: true,
      data: { municipalityCode: null },
    });
    // Bogotá D.C.
    expect(
      parse({ keyword: "clinica", departmentCode: "11", municipalityCode: "11001" }).success,
    ).toBe(true);
  });

  it("rechaza un municipio que no pertenece al departamento", () => {
    expect(municipalityBelongsTo("05001", "63")).toBe(false);
    expect(issues({ keyword: "clinica", departmentCode: "63", municipalityCode: "05001" })).toEqual(
      ["municipalityCode: El municipio no pertenece al departamento"],
    );
  });

  it("rechaza códigos inexistentes o con otro formato", () => {
    expect(issues({ keyword: "clinica", departmentCode: "00" })).toEqual([
      "departmentCode: Departamento no válido",
    ]);
    expect(issues({ keyword: "clinica", departmentCode: "63", municipalityCode: "63999" })).toEqual(
      ["municipalityCode: El municipio no pertenece al departamento"],
    );
    expect(issues({ keyword: "clinica", departmentCode: "Quindío" })).toContain(
      "departmentCode: Departamento no válido",
    );
    expect(
      issues({ keyword: "clinica", departmentCode: "63", municipalityCode: "6300" }),
    ).toContain("municipalityCode: Municipio no válido");
  });

  it("valida la palabra clave", () => {
    expect(issues({ keyword: "", departmentCode: "63" })).toContain(
      "keyword: Escribe una palabra clave",
    );
    expect(issues({ keyword: "   ", departmentCode: "63" })).toContain(
      "keyword: Escribe una palabra clave",
    );
    expect(issues({ keyword: "x".repeat(81), departmentCode: "63" })).toContain(
      "keyword: Máximo 80 caracteres",
    );
    expect(issues({ keyword: "a b c d e f g", departmentCode: "63" })).toContain(
      "keyword: Máximo 6 palabras",
    );
    expect(issues({ keyword: "clinica y", departmentCode: "63" })).toContain(
      "keyword: Cada palabra debe tener al menos 2 caracteres",
    );
    expect(issues({ keyword: "clinica\u0000", departmentCode: "63" })).toContain(
      "keyword: La palabra clave tiene caracteres no válidos",
    );
    // Texto mal codificado ("clínica" leído con otra codificación): no se busca otra cosa.
    expect(issues({ keyword: "cl�nica dental", departmentCode: "63" })).toContain(
      "keyword: La palabra clave tiene caracteres no válidos",
    );
  });
});

describe("plan de búsqueda", () => {
  const ok = (input: unknown) => {
    const r = searchCriteriaSchema.parse(input);
    return planSearch(r);
  };

  it("criterios equivalentes producen la misma consulta", () => {
    const a = ok({
      keyword: "Odontológica  Clínica",
      departmentCode: "63",
      municipalityCode: "63001",
    });
    const b = ok({
      keyword: "clinica ODONTOLOGICA",
      departmentCode: "63",
      municipalityCode: "63001",
    });
    expect(a).toEqual(b);
    expect(JSON.stringify(a.query)).toBe(JSON.stringify(b.query));
    expect(a.query).toEqual({
      v: 2,
      keywords: ["clinica", "odontologica"],
      departmentCodes: ["63"],
      municipalityCodes: ["63001"],
      providerClass: "ips",
      sources: ["reps"],
    });
  });

  it("criterios distintos producen consultas distintas", () => {
    const base = { keyword: "clinica", departmentCode: "63" };
    expect(ok(base).query).not.toEqual(ok({ ...base, municipalityCode: "63001" }).query);
    expect(ok(base).query).not.toEqual(ok({ ...base, keyword: "clinicas" }).query);
  });

  it("solo consulta adaptadores operativos que saben buscar", () => {
    const fake = (key: string, operational: boolean): SourceAdapter => ({
      key,
      name: key,
      legalBasis: "open_data",
      operational,
      capabilities: ["discover"],
      discover: async function* () {},
      resolve: () => {
        throw new Error("no usado");
      },
    });
    const criteria = searchCriteriaSchema.parse({ keyword: "clinica", departmentCode: "63" });
    const plan = planSearch(criteria, [fake("reps", true), fake("invima", false)]);
    expect(plan.query.sources).toEqual(["reps"]);
    expect(plan.adapter).toBe("reps");
    expect(() => planSearch(criteria, [fake("invima", false)])).toThrow(
      /No hay fuentes operativas/,
    );
    // En el registro real, INVIMA, CSV y sitio web están pendientes.
    expect(planSearch(criteria).query.sources).toEqual(["reps"]);
  });

  it("describe los criterios, también de las ejecuciones anteriores al buscador", () => {
    expect(
      criteriaOf(
        ok({ keyword: "Odontológica", departmentCode: "63", municipalityCode: "63001" }).query,
      ),
    ).toMatchObject({
      keyword: "odontologica",
      departmentName: "QUINDÍO",
      municipalityName: "ARMENIA",
      label: "“odontologica” en ARMENIA, QUINDÍO",
      legacy: false,
    });
    expect(
      criteriaOf({ preset: "reps-quindio", departmentCodes: ["63"], providerClass: "ips" }),
    ).toMatchObject({
      keyword: null,
      departmentName: "QUINDÍO",
      legacy: true,
      label: "IPS y clínicas de QUINDÍO (búsqueda fija anterior)",
    });
  });
});
