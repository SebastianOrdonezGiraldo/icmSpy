import { foldText, keywordTerms } from "../search-runs";
import { REPS_SERVICE_CATALOG } from "./catalog";

export { REPS_SERVICE_CATALOG } from "./catalog";

/**
 * Cómo se relaciona la palabra buscada con un servicio del catálogo oficial:
 * - exact: la palabra es el nombre del servicio ("fisioterapia" → FISIOTERAPIA).
 * - catalog: el nombre oficial del servicio contiene la palabra al inicio de
 *   alguna de sus palabras ("odonto" → ODONTOLOGIA GENERAL, ODONTOPEDIATRIA…).
 * - equivalent: equivalencia documentada en EQUIVALENCES ("fisioterapeuta",
 *   "terapia física" → FISIOTERAPIA).
 * - related: concepto relacionado documentado en RELATED. NO demuestra que el
 *   prestador ofrezca lo buscado: se muestra aparte.
 */
export type ServiceMatchKind = "exact" | "catalog" | "equivalent" | "related";
export const CONFIRMING_KINDS: readonly ServiceMatchKind[] = ["exact", "catalog", "equivalent"];

export interface ResolvedService {
  code: string;
  name: string;
  kind: ServiceMatchKind;
  /** Por qué se usa este servicio. */
  reason: string;
}

/** Palabras que no identifican un servicio por sí solas. */
const STOPWORDS = new Set([
  "de",
  "del",
  "la",
  "las",
  "el",
  "los",
  "y",
  "o",
  "en",
  "con",
  "sin",
  "para",
  "por",
  "al",
]);

interface ConceptRule {
  /** Frase (se compara en forma canónica: sin tildes, minúsculas, palabras ordenadas). */
  phrases: string[];
  codes: string[];
  reason: string;
}

/**
 * Equivalencias inequívocas: el nombre de la profesión o una denominación
 * alternativa del mismo servicio. Cada una con su justificación.
 */
export const EQUIVALENCES: readonly ConceptRule[] = [
  {
    phrases: ["fisioterapeuta", "fisioterapeutas", "terapia fisica", "terapeuta fisico"],
    codes: ["739"],
    reason:
      "Profesional que presta el servicio de fisioterapia (Ley 528 de 1999); 'terapia física' es la denominación internacional de la fisioterapia (World Physiotherapy)",
  },
  {
    phrases: ["terapeuta ocupacional", "terapeutas ocupacionales"],
    codes: ["728"],
    reason: "Profesional que presta el servicio de terapia ocupacional (Ley 949 de 2005)",
  },
  {
    phrases: ["fonoaudiologo", "fonoaudiologa", "fonoaudiologos", "fonoaudiologas"],
    codes: ["740"],
    reason: "Profesional que presta el servicio de fonoaudiología (Ley 376 de 1997)",
  },
  {
    phrases: ["terapeuta respiratorio", "terapeutas respiratorios"],
    codes: ["729"],
    reason: "Profesional que presta el servicio de terapia respiratoria (Ley 1240 de 2008)",
  },
  {
    phrases: ["psicologo", "psicologa", "psicologos", "psicologas"],
    codes: ["344"],
    reason: "Profesional que presta el servicio de psicología (Ley 1090 de 2006)",
  },
  {
    phrases: ["nutricionista", "nutricionistas"],
    codes: ["333"],
    reason: "Profesional que presta el servicio de nutrición y dietética (Ley 73 de 1979)",
  },
  {
    phrases: ["optometra", "optometras"],
    codes: ["337"],
    reason: "Profesional que presta el servicio de optometría (Ley 372 de 1997)",
  },
  {
    phrases: ["odontologo", "odontologa", "odontologos", "odontologas", "dentista", "dentistas"],
    codes: ["334"],
    reason: "Profesional que presta el servicio de odontología general (Ley 35 de 1989)",
  },
  {
    phrases: ["enfermero", "enfermera", "enfermeros", "enfermeras"],
    codes: ["312"],
    reason: "Profesional que presta el servicio de enfermería (Ley 266 de 1996)",
  },
  {
    phrases: ["fisiatra", "fisiatras"],
    codes: ["327"],
    reason: "Médico especialista en medicina física y rehabilitación",
  },
  {
    phrases: ["ortodoncista", "ortodoncistas"],
    codes: ["338"],
    reason: "Especialista que presta el servicio de ortodoncia",
  },
  {
    phrases: ["pediatra", "pediatras"],
    codes: ["342"],
    reason: "Especialista que presta el servicio de pediatría",
  },
  {
    phrases: ["psiquiatra", "psiquiatras"],
    codes: ["345"],
    reason: "Especialista que presta el servicio de psiquiatría",
  },
];

/**
 * Conceptos más amplios que un servicio. Sus resultados se muestran como
 * "relacionados", nunca como confirmación de lo buscado.
 */
export const RELATED: readonly ConceptRule[] = [
  {
    phrases: ["rehabilitacion"],
    codes: ["327", "739", "728", "740", "729"],
    reason:
      "Terapias que suelen formar parte de un proceso de rehabilitación; no implican que el prestador ofrezca 'rehabilitación' como servicio",
  },
];

const catalogEntries = REPS_SERVICE_CATALOG.map(([code, name]) => ({
  code,
  name,
  words: foldText(name)
    .split(/[^a-z0-9]+/)
    .filter(Boolean),
}));

const phraseKey = (phrase: string) => keywordTerms(phrase).join(" ");

export function serviceName(code: string): string | undefined {
  return catalogEntries.find((e) => e.code === code)?.name;
}

/**
 * Qué servicios del catálogo corresponden a una palabra clave. Determinista:
 * la misma palabra da siempre el mismo resultado. Sin IA ni inferencias.
 */
export function resolveServices(keyword: string): ResolvedService[] {
  const terms = keywordTerms(keyword);
  const meaningful = terms.filter((t) => !STOPWORDS.has(t));
  const key = terms.join(" ");
  const out = new Map<string, ResolvedService>();
  const add = (code: string, kind: ServiceMatchKind, reason: string) => {
    const name = serviceName(code);
    if (!name || out.has(code)) return;
    out.set(code, { code, name, kind, reason });
  };

  if (meaningful.length > 0) {
    for (const e of catalogEntries) {
      // Alguna palabra buscada debe ser el comienzo del nombre del servicio (su
      // núcleo: ODONTOLOGIA GENERAL, TERAPIA OCUPACIONAL) y las demás deben
      // aparecer en él. Así "clínica" no resuelve a ONCOLOGIA CLINICA.
      const head = e.words[0] ?? "";
      const matchesAll =
        meaningful.some((t) => head.startsWith(t)) &&
        meaningful.every((t) => e.words.some((w) => w.startsWith(t)));
      if (!matchesAll) continue;
      const significant = e.words.filter((w) => !STOPWORDS.has(w)).sort();
      const exact = significant.join(" ") === [...meaningful].sort().join(" ");
      add(
        e.code,
        exact ? "exact" : "catalog",
        exact
          ? "Nombre oficial del servicio"
          : "El nombre oficial del servicio contiene la palabra",
      );
    }
  }
  for (const rule of EQUIVALENCES) {
    if (rule.phrases.some((p) => phraseKey(p) === key)) {
      for (const code of rule.codes) add(code, "equivalent", rule.reason);
    }
  }
  for (const rule of RELATED) {
    if (rule.phrases.some((p) => phraseKey(p) === key)) {
      for (const code of rule.codes) add(code, "related", rule.reason);
    }
  }
  const order: Record<ServiceMatchKind, number> = {
    exact: 0,
    equivalent: 1,
    catalog: 2,
    related: 3,
  };
  return [...out.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.code.localeCompare(b.code),
  );
}
