import { DIVIPOLA, type DivipolaDepartment } from "./divipola";

export { DIVIPOLA, type DivipolaDepartment, type DivipolaMunicipality } from "./divipola";

const departmentsByCode = new Map(DIVIPOLA.map((d) => [d.code, d]));
const municipalitiesByCode = new Map(
  DIVIPOLA.flatMap((d) =>
    d.municipalities.map(([code, name]) => [code, { code, name, departmentCode: d.code }] as const),
  ),
);

export function getDepartment(code: string): DivipolaDepartment | undefined {
  return departmentsByCode.get(code);
}

export function getMunicipality(
  code: string,
): { code: string; name: string; departmentCode: string } | undefined {
  return municipalitiesByCode.get(code);
}

/** true si el municipio existe y pertenece al departamento. */
export function municipalityBelongsTo(municipalityCode: string, departmentCode: string): boolean {
  return getMunicipality(municipalityCode)?.departmentCode === departmentCode;
}
