import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as admin } from "@/app/api/admin/route";
import { POST as ciclo } from "@/app/api/ciclo/route";
import { GET as clienteGet } from "@/app/api/cliente/[id]/route";
import { POST as humano } from "@/app/api/humano/route";
import { POST as pagos } from "@/app/api/pagos/route";
import { POST as seguimiento } from "@/app/api/seguimiento/route";
import { getDb } from "@/lib/adapters/sqlite";
import { enmascararCelular } from "@/lib/auth";
import { repos } from "@/lib/container";
import { ndjson } from "@/lib/stream";
import { crearCliente, reiniciar } from "./helpers";

type Cab = Record<string, string>;
const req = (body: unknown, cab: Cab = { host: "localhost:3000" }, raw?: string) =>
  new Request("http://localhost:3000/api/x", { method: "POST", headers: { "content-type": "application/json", ...cab }, body: raw ?? JSON.stringify(body) });
const conToken = { host: "localhost:3000" };
const cuenta = async (tabla: string) => Number((await (await getDb()).execute(`SELECT COUNT(*) n FROM ${tabla}`)).rows[0].n);

beforeEach(async () => { vi.unstubAllEnvs(); await reiniciar(); });
afterEach(() => vi.unstubAllEnvs());

describe("P0-C · acciones administrativas", () => {
  it("el reinicio exige confirmación explícita y no borra nada sin ella", async () => {
    await crearCliente({ cliente_id: "KEEP2" });
    const antes = await cuenta("cartera");
    expect((await admin(req({ accion: "reset" }))).status).toBe(400);
    expect(await cuenta("cartera")).toBe(antes);
    expect((await admin(req({ accion: "reset", confirmar: "REINICIAR" }))).status).toBe(200);
    expect(await cuenta("cartera")).toBe(800);
  });
  it("CSRF: un cuerpo que no es application/json se rechaza y no reinicia la base", async () => {
    await crearCliente({ cliente_id: "KEEP4" });
    const antes = await cuenta("cartera");
    const plano = new Request("http://localhost:3000/api/admin", { method: "POST", headers: { origin: "http://sitio-malo.example", "content-type": "text/plain" }, body: '{"accion":"reset","confirmar":"REINICIAR"}' });
    expect((await admin(plano)).status).toBe(415);
    expect(await cuenta("cartera")).toBe(antes);
  });
});

describe("validación de entradas (Zod)", () => {
  it.each([
    ["JSON roto", undefined, "{no es json"],
    ["id con path traversal", { clienteId: "../../etc/passwd" }, undefined],
    ["id vacío", { clienteId: "" }, undefined],
    ["campo desconocido", { clienteId: "CL0002", admin: true }, undefined],
    ["modo inválido", { clienteId: "CL0002", modo: "gpt" }, undefined],
    ["fase inválida", { clienteId: "CL0002", fase: "borrar" }, undefined],
    ["respuesta demasiado larga", { clienteId: "CL0002", respuestasCliente: ["x".repeat(500)] }, undefined],
  ])("ciclo rechaza %s con 400 y sin detalles internos", async (_n, body, raw) => {
    const r = await ciclo(req(body, conToken, raw));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(JSON.stringify(j)).not.toMatch(/stack|node_modules|at \w+ \(|sqlite/i);
  });
  it("cuerpo gigante → 413", async () => {
    expect((await ciclo(req({ clienteId: "CL0002", x: "a".repeat(30_000) }, conToken))).status).toBe(413);
  });
  it.each([
    [{ clienteId: "CL0002", referencia: "OP-1", monto: -5 }],
    [{ clienteId: "CL0002", referencia: "OP-1", monto: 0 }],
    [{ clienteId: "CL0002", referencia: "OP-1", monto: "diez" }],
    [{ clienteId: "CL0002", referencia: "x", monto: 5 }],
    [{ clienteId: "CL0002", referencia: "OP 1; DROP TABLE cartera", monto: 5 }],
    [{ clienteId: "CL0002", referencia: "OP-1", monto: 1e12 }],
  ])("pagos rechaza %j", async (b) => {
    expect((await pagos(req(b, conToken))).status).toBe(400);
    expect(await cuenta("pagos")).toBe(0);
  });
  it("humano: 'enviar' exige mensaje; acciones desconocidas se rechazan", async () => {
    expect((await humano(req({ clienteId: "CL0002", accion: "enviar" }, conToken))).status).toBe(400);
    expect((await humano(req({ clienteId: "CL0002", accion: "borrar_todo" }, conToken))).status).toBe(400);
  });
  it("admin: lote fuera de rango y acciones desconocidas → 400", async () => {
    expect((await admin(req({ accion: "lote", n: 5000 }, conToken))).status).toBe(400);
    expect((await admin(req({ accion: "formatear" }, conToken))).status).toBe(400);
  });
  it("un pago duplicado vía API no descuenta dos veces", async () => {
    await crearCliente();
    const p = (m: number) => pagos(req({ clienteId: "T0001", referencia: "OP-DUP", monto: m }, conToken));
    expect((await p(300)).status).toBe(200);
    const r2 = await p(300);
    expect((await r2.json()).estado).toBe("duplicado");
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(550);
    expect((await pagos(req({ clienteId: "T0001", referencia: "OP-BIG", monto: 9999 }, conToken))).status).toBe(422);
  });
});

describe("privacidad y errores", () => {
  it("la API de lectura enmascara el celular y no expone campos del simulador", async () => {
    await crearCliente({ celular: "987654321" });
    const r = await clienteGet(new Request("http://localhost/api/cliente/T0001"), { params: Promise.resolve({ id: "T0001" }) });
    const j = await r.json();
    expect(j.cliente.celular).toBe("98•••••21");
    expect(JSON.stringify(j)).not.toContain("987654321");
    expect(j.cliente).not.toHaveProperty("sim_escenario");
    expect(j.cliente).not.toHaveProperty("sim_pago_base");
    expect(enmascararCelular("12")).toBe("••••");
    expect((await clienteGet(new Request("http://x"), { params: Promise.resolve({ id: "../x" }) })).status).toBe(400);
    expect((await clienteGet(new Request("http://x"), { params: Promise.resolve({ id: "NOEXISTE" }) })).status).toBe(404);
  });
  it("en producción un error del agente no filtra el mensaje interno al navegador", async () => {
    vi.stubEnv("NODE_ENV", "production");
    async function* rota(): AsyncGenerator<never> { throw new Error("secreto: CLAVE-FALSA-DE-PRUEBA /srv/app/db.sqlite"); }
    const txt = await ndjson(rota()).text();
    expect(txt).toContain('"estado":"error"');
    expect(txt).not.toMatch(/CLAVE-FALSA|secreto|sqlite/);
  });
});
