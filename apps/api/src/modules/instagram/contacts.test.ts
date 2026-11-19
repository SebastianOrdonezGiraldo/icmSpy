import { describe, expect, it } from "vitest";
import { extractContacts, normalizeEmail, normalizePhone } from "./contacts";

const ok = (p: { businessEmail?: string; businessPhone?: string; biography?: string }) =>
  ({
    status: "ok",
    isPrivate: false,
    businessEmail: p.businessEmail ?? null,
    businessPhone: p.businessPhone ?? null,
    biography: p.biography ?? null,
  }) as const;

describe("normalización", () => {
  it("correos en minúsculas; rechaza lo que no es un correo", () => {
    expect(normalizeEmail(" Ventas@Negocio.Example ")).toBe("ventas@negocio.example");
    expect(normalizeEmail("ventas@negocio")).toBeNull();
  });

  it("teléfonos: +57 a celulares y fijos colombianos sin prefijo; internacionales con +", () => {
    expect(normalizePhone("300 555 0001")).toBe("+573005550001");
    expect(normalizePhone("(601) 555-0001")).toBe("+576015550001");
    expect(normalizePhone("+57 601 555 0001")).toBe("+576015550001");
    expect(normalizePhone("57 300 555 0001")).toBe("+573005550001");
    expect(normalizePhone("+1 (212) 555-0100")).toBe("+12125550100");
    expect(normalizePhone("5550100")).toBe("5550100");
    expect(normalizePhone("2026")).toBeNull();
  });
});

describe("extractContacts", () => {
  it("toma los botones y la biografía, sin duplicados (prevalece el botón)", () => {
    expect(
      extractContacts(
        ok({
          businessEmail: "Ventas@Negocio-Demo.example",
          businessPhone: "+57 601 555 0001",
          biography: "Pedidos: ventas@negocio-demo.example · WhatsApp 300 555 0002 · Desde 2026",
        }),
      ),
    ).toEqual([
      {
        kind: "email",
        value: "ventas@negocio-demo.example",
        original: "Ventas@Negocio-Demo.example",
        source: "button",
      },
      { kind: "phone", value: "+573005550002", original: "300 555 0002", source: "biography" },
      { kind: "phone", value: "+576015550001", original: "+57 601 555 0001", source: "button" },
    ]);
  });

  it("perfil privado, no encontrado o sin datos: ningún contacto", () => {
    expect(extractContacts({ ...ok({ businessEmail: "a@b.example" }), isPrivate: true })).toEqual(
      [],
    );
    expect(extractContacts({ status: "not_found" })).toEqual([]);
    expect(extractContacts(ok({ biography: "Fisioterapia deportiva en Bogotá 🦩" }))).toEqual([]);
  });

  it("no lee dígitos de un correo como teléfono", () => {
    expect(extractContacts(ok({ biography: "escribe a info3005550001@negocio.example" }))).toEqual([
      {
        kind: "email",
        value: "info3005550001@negocio.example",
        original: "info3005550001@negocio.example",
        source: "biography",
      },
    ]);
  });
});
