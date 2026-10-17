import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as admin } from "@/app/api/admin/route";
import { POST as ciclo } from "@/app/api/ciclo/route";
import { GET as clienteGet } from "@/app/api/cliente/[id]/route";
import { POST as humano } from "@/app/api/humano/route";
import { POST as pagos } from "@/app/api/pagos/route";
import { POST as seguimiento } from "@/app/api/seguimiento/route";
import { getDb } from "@/lib/adapters/sqlite";
import { autorizarAdmin, enmascararCelular } from "@/lib/auth";
import { repos } from "@/lib/container";
import { ndjson } from "@/lib/stream";
import { crearCliente, reiniciar } from "./helpers";

const TOKEN = "tok-de-prueba-123";
type Cab = Record<string, string>;
const req = (body: unknown, cab: Cab = { host: "localhost:3000" }, raw?: string) =>
  new Request("http://localhost:3000/api/x", { method: "POST", headers: { "content-type": "application/json", ...cab }, body: raw ?? JSON.stringify(body) });
const conToken = { host: "localhost:3000", "x-admin-token": TOKEN };
const cuenta = async (tabla: string) => Number((await (await getDb()).execute(`SELECT COUNT(*) n FROM ${tabla}`)).rows[0].n);

beforeEach(async () => { vi.unstubAllEnvs(); await reiniciar(); });
afterEach(() => vi.unstubAllEnvs());

describe("P0-C · acciones administrativas protegidas", () => {
  it("producción sin NEXO_ADMIN_TOKEN: TODO queda deshabilitado y el reinicio NO borra nada", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await crearCliente({ cliente_id: "KEEP1" });
    const antes = await cuenta("cartera");
    const r = await admin(req({ accion: "reset", confirmar: "REINICIAR" }));
    expect(r.status).toBe(403);
    expect(await cuenta("cartera")).toBe(antes);
    for (const [h, b] of [[ciclo, { clienteId: "CL0002" }], [humano, { clienteId: "CL0002", accion: "cerrar" }], [seguimiento, { clienteId: "CL0002" }], [pagos, { clienteId: "CL0002", referencia: "OP-1", monto: 10 }]] as const)
      expect((await h(req(b))).status).toBe(403);
    expect(await cuenta("gestiones")).toBe(0);
    expect(await cuenta("pagos")).toBe(0);
  });
  it("con token: sin token o con token erróneo → 401 sin tocar la base; con token correcto → ok", async () => {
    vi.stubEnv("NEXO_ADMIN_TOKEN", TOKEN);
    await crearCliente({ cliente_id: "KEEP2" });
    const antes = await cuenta("cartera");
    expect((await admin(req({ accion: "reset", confirmar: "REINICIAR" }, { host: "localhost" }))).status).toBe(401);
    expect((await admin(req({ accion: "reset", confirmar: "REINICIAR" }, { host: "localhost", "x-admin-token": "otro" }))).status).toBe(401);
    expect((await admin(req({ accion: "reset", confirmar: "REINICIAR" }, { host: "evil.com", authorization: "Bearer mal" }))).status).toBe(401);
    expect(await cuenta("cartera")).toBe(antes);
    expect((await pagos(req({ clienteId: "KEEP2", referencia: "OP-9", monto: 50 }, { host: "x.com" }))).status).toBe(401);
    expect((await pagos(req({ clienteId: "KEEP2", referencia: "OP-9", monto: 50 }, { host: "x.com", authorization: `Bearer ${TOKEN}` }))).status).toBe(200);
    // reinicio con token correcto pero SIN confirmación explícita → 400
    expect((await admin(req({ accion: "reset" }, conToken))).status).toBe(400);
    expect(await cuenta("cartera")).toBe(antes);
    expect((await admin(req({ accion: "reset", confirmar: "REINICIAR" }, conToken))).status).toBe(200);
    expect(await cuenta("cartera")).toBe(800);
  });
  it("sin token configurado TODO queda deshabilitado, también en desarrollo y también desde localhost (no se confía en Host)", async () => {
    await crearCliente({ cliente_id: "KEEP3" });
    const antes = await cuenta("cartera");
    for (const host of ["localhost:3000", "127.0.0.1", "[::1]:3000", "evil.com"]) {
      expect(autorizarAdmin(req({}, { host })).ok).toBe(false);
      expect((await admin(req({ accion: "reset", confirmar: "REINICIAR" }, { host }))).status).toBe(403);
    }
    // aunque el atacante envíe cualquier valor como token, sin token configurado en el servidor no hay acceso
    expect((await admin(req({ accion: "reset", confirmar: "REINICIAR" }, { host: "localhost", "x-admin-token": "" }))).status).toBe(403);
    expect(await cuenta("cartera")).toBe(antes);
  });
  it("CSRF: un POST «simple» entre sitios (text/plain, sin cabecera de token) no puede reiniciar la base", async () => {
    vi.stubEnv("NEXO_ADMIN_TOKEN", TOKEN);
    await crearCliente({ cliente_id: "KEEP4" });
    const antes = await cuenta("cartera");
    const csrf = new Request("http://localhost:3000/api/admin", { method: "POST", headers: { host: "localhost:3000", origin: "http://sitio-malo.example", "content-type": "text/plain" }, body: '{"accion":"reset","confirmar":"REINICIAR"}' });
    expect((await admin(csrf)).status).toBe(401); // falta el token (cabecera personalizada ⇒ exige preflight)
    // y aunque tuviera el token, un cuerpo que no es application/json se rechaza
    const plano = new Request("http://localhost:3000/api/admin", { method: "POST", headers: { "x-admin-token": TOKEN, "content-type": "text/plain" }, body: '{"accion":"reset","confirmar":"REINICIAR"}' });
    expect((await admin(plano)).status).toBe(415);
    expect(await cuenta("cartera")).toBe(antes);
  });
  it("las operaciones del asesor exigen autorización y no escriben nada si se rechazan", async () => {
    vi.stubEnv("NEXO_ADMIN_TOKEN", TOKEN);
    await crearCliente();
    expect((await humano(req({ clienteId: "T0001", accion: "enviar", mensaje: "Hola, soy asesor" }, { host: "localhost" }))).status).toBe(401);
    expect(await cuenta("gestiones")).toBe(0);
  });
});

describe("validación de entradas (Zod)", () => {
  beforeEach(() => vi.stubEnv("NEXO_ADMIN_TOKEN", TOKEN));
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
