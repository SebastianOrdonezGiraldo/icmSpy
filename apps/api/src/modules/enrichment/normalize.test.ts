import { describe, expect, it } from "vitest";
import {
  isRoleAddress,
  normalizeDomain,
  normalizeEmail,
  normalizeNit,
  normalizePhoneCO,
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

  it("normaliza NIT y dominios", () => {
    expect(normalizeNit("900.123.456-7")).toBe("900123456");
    expect(normalizeNit("abc")).toBeNull();
    expect(normalizeDomain("https://www.Clinica.com/contacto")).toBe("clinica.com");
    expect(normalizeDomain("clinica")).toBeNull();
  });
});
