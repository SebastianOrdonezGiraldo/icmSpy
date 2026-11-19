/** Demo con datos de prueba: URL del perfil, directorio ficticio y resultado (sin base ni red). */
import { describe, expect, it } from "vitest";
import { collect, createRun } from "./collect";
import {
  buildDemoResult,
  DEMO_BUDGET,
  DEMO_EXAMPLES,
  DEMO_REQUESTED,
  parseInstagramProfileUrl,
} from "./demo";
import { SyntheticInstagramProvider } from "./fake-provider";
import { MemoryRunStore } from "./store";

describe("parseInstagramProfileUrl", () => {
  it("acepta URL de perfil, con o sin www, barra final o parámetros, y @usuario", () => {
    for (const input of [
      "https://www.instagram.com/demo_clinica_aurora/",
      "https://instagram.com/demo_clinica_aurora",
      "www.instagram.com/Demo_Clinica_Aurora/?hl=es",
      "@demo_clinica_aurora",
      "  demo_clinica_aurora  ",
    ]) {
      expect(parseInstagramProfileUrl(input)).toBe("demo_clinica_aurora");
    }
  });

  it("rechaza otros dominios, publicaciones y rutas reservadas", () => {
    for (const input of [
      "https://example.com/demo",
      "https://www.instagram.com/p/ABC123/",
      "https://www.instagram.com/explore/",
      "https://www.instagram.com/",
      "no es un perfil",
      "",
    ]) {
      expect(parseInstagramProfileUrl(input)).toBeNull();
    }
  });
});

async function runDemo(profileUrl: string) {
  const username = parseInstagramProfileUrl(profileUrl) as string;
  const store = new MemoryRunStore();
  await createRun(store, {
    id: "demo",
    username,
    requested: DEMO_REQUESTED,
    budgetMaxCalls: DEMO_BUDGET,
    enrichProfiles: true,
  });
  await collect({ provider: new SyntheticInstagramProvider(), store }, "demo");
  return buildDemoResult(store.snapshot("demo"));
}

describe("resultado de la demo", () => {
  it("ejemplo con contactos ficticios: botones y biografía; privados sin consultar", async () => {
    const r = await runDemo(DEMO_EXAMPLES[0].profileUrl);
    expect(r).toMatchObject({
      status: "done",
      stopReason: "target_reached",
      // resolución + 2 páginas + 38 perfiles públicos (los 12 privados no se consultan)
      progress: {
        collected: 50,
        requested: 50,
        profilesDone: 38,
        profilesToQuery: 38,
        attempts: 41,
        budget: DEMO_BUDGET,
      },
      summary: {
        rows: 50,
        privateSkipped: 12,
        withEmail: 26,
        withPhone: 26,
        withoutContact: 12,
        pending: 0,
        notFound: 0,
      },
    });
    expect(r.rows[0]).toMatchObject({
      position: 1,
      enrichment: "con_contacto",
      email: "contacto1@negocio-demo.example",
      emailSource: "button",
      phone: "+57 601 555 0001",
      phoneSource: "button",
    });
    expect(r.rows[1]).toMatchObject({
      enrichment: "con_contacto",
      email: "ventas2@negocio-demo.example",
      emailSource: "biography",
      phone: "300 555 0002",
      phoneSource: "biography",
    });
    expect(r.rows[3]).toMatchObject({
      position: 4,
      enrichment: "privado",
      email: null,
      phone: null,
    });
  });

  it("ejemplo sin contacto publicado: perfiles consultados, ningún correo ni teléfono", async () => {
    const r = await runDemo(DEMO_EXAMPLES[1].profileUrl);
    expect(r.summary).toEqual({
      rows: 50,
      privateSkipped: 12,
      withEmail: 0,
      withPhone: 0,
      withoutContact: 38,
      pending: 0,
      notFound: 0,
    });
  });
});
