/** Validación del destino de las pruebas de integración, sin conectar a ninguna base. */
import { afterEach, describe, expect, it } from "vitest";
import { checkDisposableTarget } from "./pg-test-target";

const PG_VARS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER"] as const;
const saved = Object.fromEntries(PG_VARS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of PG_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("checkDisposableTarget (sin conexión)", () => {
  it("acepta la instancia local desechable prevista", () => {
    expect(checkDisposableTarget("postgres://u:p@127.0.0.1:55434/ig_it", 55434)).toEqual({
      host: "127.0.0.1",
      port: 55434,
      database: "ig_it",
      user: "u",
    });
    expect(checkDisposableTarget("postgres://u:p@localhost:55434/ig_x", 55434).host).toBe(
      "localhost",
    );
  });

  it("rechaza un host remoto, otro puerto o una base del proyecto", () => {
    expect(() => checkDisposableTarget("postgres://u:p@10.0.0.5:55434/ig_it", 55434)).toThrow(
      /no local/,
    );
    expect(() => checkDisposableTarget("postgres://u:p@127.0.0.1:5433/ig_it", 55434)).toThrow(
      /Puerto 5433/,
    );
    for (const db of ["icmspy", "icmspy_test", "postgres", "reps_ig"]) {
      expect(() => checkDisposableTarget(`postgres://u:p@127.0.0.1:55434/${db}`, 55434)).toThrow(
        /no permitida/,
      );
    }
    expect(() => checkDisposableTarget("postgres://u:p@127.0.0.1:55434/ig_it", 0)).toThrow(
      /puerto esperado/,
    );
  });

  it("valida el destino efectivo: ?host= sustituye al host de la URL", () => {
    expect(() =>
      checkDisposableTarget("postgres://u:p@127.0.0.1:55434/ig_it?host=db.example.com", 55434),
    ).toThrow(/db\.example\.com/);
  });

  it("valida el destino efectivo: lo que falta en la URL sale de las variables PG*", () => {
    process.env.PGHOST = "db.example.com";
    process.env.PGPORT = "5433";
    process.env.PGDATABASE = "icmspy";
    expect(() => checkDisposableTarget("postgres:///", 55434)).toThrow(/db\.example\.com/);
    process.env.PGHOST = "127.0.0.1";
    expect(() => checkDisposableTarget("postgres:///", 55434)).toThrow(/Puerto 5433/);
    process.env.PGPORT = "55434";
    expect(() => checkDisposableTarget("postgres:///", 55434)).toThrow(/icmspy/);
  });
});
