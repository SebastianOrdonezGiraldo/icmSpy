/**
 * Indicativo regional de la numeración fija por departamento (código DANE de
 * dos dígitos). Es el dígito X de los NDC 60X: un fijo de 7 dígitos del
 * departamento se marca hoy 60X + número, y antes de 2021 se escribía con el
 * indicativo X.
 *
 * Fuente: CRC, SIGRID, "Atribuciones de numeración E.164"
 * (https://www.pnn.gov.co/mapa/atribuciones/numeracionE164.xhtml), consultada el 2026-11-13:
 *   601 Bogotá D.C. y Cundinamarca · 602 Cauca, Nariño y Valle · 604 Antioquia, Córdoba y Chocó ·
 *   605 Atlántico, Bolívar, Cesar, La Guajira, Magdalena y Sucre · 606 Caldas, Quindío y Risaralda ·
 *   607 Arauca, Norte de Santander y Santander · 608 Amazonas, Boyacá, Casanare, Caquetá, Guaviare,
 *   Guainía, Huila, Meta, Tolima, Putumayo, San Andrés, Vaupés y Vichada.
 */
export const LANDLINE_AREA_BY_DEPARTMENT: Readonly<Record<string, string>> = {
  "05": "4", // Antioquia
  "08": "5", // Atlántico
  "11": "1", // Bogotá D.C.
  "13": "5", // Bolívar
  "15": "8", // Boyacá
  "17": "6", // Caldas
  "18": "8", // Caquetá
  "19": "2", // Cauca
  "20": "5", // Cesar
  "23": "4", // Córdoba
  "25": "1", // Cundinamarca
  "27": "4", // Chocó
  "41": "8", // Huila
  "44": "5", // La Guajira
  "47": "5", // Magdalena
  "50": "8", // Meta
  "52": "2", // Nariño
  "54": "7", // Norte de Santander
  "63": "6", // Quindío
  "66": "6", // Risaralda
  "68": "7", // Santander
  "70": "5", // Sucre
  "73": "8", // Tolima
  "76": "2", // Valle del Cauca
  "81": "7", // Arauca
  "85": "8", // Casanare
  "86": "8", // Putumayo
  "88": "8", // San Andrés, Providencia y Santa Catalina
  "91": "8", // Amazonas
  "94": "8", // Guainía
  "95": "8", // Guaviare
  "97": "8", // Vaupés
  "99": "8", // Vichada
};

/** Indicativo del departamento de un municipio (código DANE de 5 dígitos), si se conoce. */
export function landlineAreaForMunicipality(municipalityCode: string): string | undefined {
  return LANDLINE_AREA_BY_DEPARTMENT[municipalityCode.slice(0, 2)];
}
