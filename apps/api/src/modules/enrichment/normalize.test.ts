import { describe, expect, it } from "vitest";
import {
  isRoleAddress,
  normalizeDomain,
  normalizeEmail,
  normalizeNit,
  normalizePhoneCO,
  parseEmails,
  parsePhonesCO,
} from "./normalize";

describe("normalize", () => {
  it("normaliza correos", () => {
    expect(normalizeEmail("  Ventas@Clinica.COM ")).toBe("ventas@clinica.com");
    expect(normalizeEmail("no-es-correo")).toBeNull();
  });

  it("distingue buzones de rol de personales", () => {
    expect(isRoleAddress("ventas@clinica.com")).toBe(true);
    expect(isRoleAddress("servicio.al.cliente@clinica.com")).toBe(true);
    expect(isRoleAddress("juan.perez@clinica.com")).toBe(false);
  });

  it("normaliza teléfonos colombianos", () => {
    expect(normalizePhoneCO("310 555 1234")).toBe("+573105551234");
    expect(normalizePhoneCO("+57 (606) 745-1234")).toBe("+576067451234");
    expect(normalizePhoneCO("7451234")).toBeNull();
  });

  it("interpreta fijos con el formato anterior a 2021 solo si conoce el indicativo", () => {
    expect(normalizePhoneCO("(6) 745 1234")).toBe("+576067451234");
    expect(normalizePhoneCO("57 6 7451234")).toBe("+576067451234");
    expect(normalizePhoneCO("7451234", { landlineArea: "6" })).toBe("+576067451234");
    expect(normalizePhoneCO("7451234")).toBeNull();
  });

  it("interpreta la larga distancia anterior a 2021 con operador 9 solo si el indicativo cuadra", () => {
    const quindio = { landlineArea: "6" };
    // [0] + operador 9 + indicativo 6 + número de 7 dígitos → 60 + 6 + número.
    expect(normalizePhoneCO("(096) 7451234", quindio)).toBe("+576067451234");
    expect(normalizePhoneCO("(096)7451234", quindio)).toBe("+576067451234");
    expect(normalizePhoneCO("967451234", quindio)).toBe("+576067451234");
    // Sin ubicación conocida, o con otro indicativo, no se interpreta.
    expect(normalizePhoneCO("967451234")).toBeNull();
    expect(normalizePhoneCO("967451234", { landlineArea: "4" })).toBeNull();
    expect(normalizePhoneCO("947451234", quindio)).toBeNull();
    // Operador no admitido ("03" era el prefijo de fijo a celular, no un operador).
    expect(normalizePhoneCO("(036) 7451234", quindio)).toBeNull();
    expect(normalizePhoneCO("(056) 7451234", quindio)).toBeNull();
    // Abonado que empieza por 1, o con 8 dígitos: ambiguo, no se adivina ni se recorta.
    expect(normalizePhoneCO("961451234", quindio)).toBeNull();
    expect(normalizePhoneCO("0967-4512345", quindio)).toBeNull();
  });

  it("sigue descartando números incompletos o con dígitos de más", () => {
    const quindio = { landlineArea: "6" };
    expect(normalizePhoneCO("745123", quindio)).toBeNull();
    expect(normalizePhoneCO("31055512345", quindio)).toBeNull();
    expect(normalizePhoneCO("18005551234", quindio)).toBeNull();
    expect(normalizePhoneCO("576 3105551234", quindio)).toBeNull();
  });

  it("separa campos con varios teléfonos y conserva el fragmento original", () => {
    expect(parsePhonesCO("7451234 3105551234", { landlineArea: "6" })).toEqual([
      { raw: "7451234", normalized: "+576067451234" },
      { raw: "3105551234", normalized: "+573105551234" },
    ]);
    expect(parsePhonesCO("745-12-34 Ext. 101", { landlineArea: "6" })).toEqual([
      { raw: "745-12-34 Ext. 101", normalized: "+576067451234" },
    ]);
    expect(parsePhonesCO("310 555 1234")).toEqual([
      { raw: "310 555 1234", normalized: "+573105551234" },
    ]);
  });

  it("separa por etiquetas de teléfono sin incluirlas en el valor", () => {
    expect(parsePhonesCO("fijo 606 7451234 Cel 3105551234")).toEqual([
      { raw: "606 7451234", normalized: "+576067451234" },
      { raw: "3105551234", normalized: "+573105551234" },
    ]);
    expect(parsePhonesCO("Tel: 3105551234 - Celular. 3125551234")).toEqual([
      { raw: "3105551234", normalized: "+573105551234" },
      { raw: "3125551234", normalized: "+573125551234" },
    ]);
    // Una etiqueta sin número no produce nada.
    expect(parsePhonesCO("Tel")).toEqual([]);
  });

  it("separa alternativas unidas por « o »", () => {
    expect(parsePhonesCO("7451-000 o 7451-001", { landlineArea: "6" })).toEqual([
      { raw: "7451-000", normalized: "+576067451000" },
      { raw: "7451-001", normalized: "+576067451001" },
    ]);
  });

  it("separa primero por espacios para no romper un fijo escrito con guiones", () => {
    expect(parsePhonesCO("745-12-34 3105551234", { landlineArea: "6" })).toEqual([
      { raw: "745-12-34", normalized: "+576067451234" },
      { raw: "3105551234", normalized: "+573105551234" },
    ]);
    // Sigue separando por guion cuando no hay espacio.
    expect(parsePhonesCO("3105551234-3125551234")).toEqual([
      { raw: "3105551234", normalized: "+573105551234" },
      { raw: "3125551234", normalized: "+573125551234" },
    ]);
    // Si una parte no es válida, solo esa se descarta.
    expect(parsePhonesCO("31055512345-- 3125551234")).toEqual([
      { raw: "31055512345", normalized: null },
      { raw: "3125551234", normalized: "+573125551234" },
    ]);
  });

  it("no confunde una extensión con otro número", () => {
    expect(parsePhonesCO("7451234 Ext. 12 - 3105551234", { landlineArea: "6" })).toEqual([
      { raw: "7451234 Ext. 12", normalized: "+576067451234" },
      { raw: "3105551234", normalized: "+573105551234" },
    ]);
    expect(parsePhonesCO("(096)7451234   7451235  745123", { landlineArea: "6" })).toEqual([
      { raw: "(096)7451234", normalized: "+576067451234" },
      { raw: "7451235", normalized: "+576067451235" },
      { raw: "745123", normalized: null },
    ]);
  });

  it("separa campos con varios correos", () => {
    expect(parseEmails("a@x.com,  B@Y.com / malo")).toEqual([
      { raw: "a@x.com", normalized: "a@x.com" },
      { raw: "B@Y.com", normalized: "b@y.com" },
      { raw: "malo", normalized: null },
    ]);
  });

  it("normaliza NIT y dominios", () => {
    expect(normalizeNit("900.123.456-7")).toBe("900123456");
    expect(normalizeNit("abc")).toBeNull();
    expect(normalizeDomain("https://www.Clinica.com/contacto")).toBe("clinica.com");
    expect(normalizeDomain("clinica")).toBeNull();
  });
});
