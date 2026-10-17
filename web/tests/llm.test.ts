import { beforeEach, describe, expect, it } from "vitest";
import { gestorLlm, type Estructurado } from "@/lib/adapters/gestor-llm";
import { gestorScripted } from "@/lib/adapters/scripted";
import { clienteConRespaldo, getCtx, gestorConRespaldo, repos } from "@/lib/container";
import { ciclo } from "@/lib/core/orquestador";
import type { GestorAgent } from "@/lib/core/ports";
import { conAviso } from "@/lib/stream";
import { correr, crearCliente, ctxTest, reiniciar } from "./helpers";

beforeEach(reiniciar);

const turnoOk = { mensaje: "Hola Ana, ¿qué pasó con tu cuota?", motivo_no_pago: "desconocido", accion: "preguntar", regla_id: null, monto_promesa: null, fecha_promesa: null, justificacion: "primer contacto", resumen_humano: null, borrador_humano: null };
const entrada = async () => ({ cliente: await crearCliente(), reglas: await (await ctxTest()).reglasRepo.todas(), historial: [], hoy: "2026-10-14", numeroTurno: 1 });

describe("Gestor LLM: salida estructurada y telemetría REAL (modelo simulado, sin red)", () => {
  it("instruye al modelo a redactar el borrador del Supervisor para el cliente", async () => {
    const m: Estructurado = { invoke: async (messages) => {
      expect(messages[0].content).toContain("el remitente es el SUPERVISOR y el destinatario es el CLIENTE");
      expect(messages[0].content).toContain('soy el Supervisor de tu banco');
      return { parsed: turnoOk, raw: {} };
    } };
    await gestorLlm("deepseek/test", m).turno(await entrada());
  });

  it("valida con Zod, etiqueta motor=llm y toma los tokens que informa el proveedor", async () => {
    const m: Estructurado = { invoke: async () => ({ parsed: turnoOk, raw: { usage_metadata: { input_tokens: 1200, output_tokens: 80 } } }) };
    const t = await gestorLlm("deepseek/test", m).turno(await entrada());
    expect(t.meta).toMatchObject({ motor: "llm", modelo: "deepseek/test", tokens_in: 1200, tokens_out: 80 });
    expect(t.meta!.latencia_ms).toBeGreaterThanOrEqual(0);
    const k = (await repos.kpis.kpis()).llm;
    expect(k).toMatchObject({ llamadas: 1, fallidas: 0, tokensIn: 1200, tokensOut: 80 });
  });
  it("si el proveedor no devuelve usage, los tokens son null ('No disponible'), nunca un número inventado", async () => {
    const m: Estructurado = { invoke: async () => ({ parsed: turnoOk, raw: {} }) };
    const t = await gestorLlm("x/y", m).turno(await entrada());
    expect(t.meta).toMatchObject({ motor: "llm", tokens_in: null, tokens_out: null });
    expect((await repos.kpis.kpis()).llm).toMatchObject({ llamadas: 1, tokensIn: null, tokensOut: null });
  });
  it("una salida inválida se reintenta UNA vez (gasto acotado) y luego falla; las dos llamadas quedan registradas como fallidas", async () => {
    let n = 0;
    const m: Estructurado = { invoke: async () => { n++; return { parsed: { ...turnoOk, accion: "inventar_condicion" }, raw: {} }; } };
    await expect(gestorLlm("x/y", m).turno(await entrada())).rejects.toThrow(/inválida/);
    expect(n).toBe(2);
    expect((await repos.kpis.kpis()).llm).toMatchObject({ llamadas: 2, fallidas: 2 });
  });
  it("una salida inválida seguida de una válida se recupera sin tocar el estado", async () => {
    let n = 0;
    const m: Estructurado = { invoke: async () => ({ parsed: n++ === 0 ? null : turnoOk, raw: {} }) };
    expect((await gestorLlm("x/y", m).turno(await entrada())).meta!.motor).toBe("llm");
  });
});

describe("fallo del proveedor → respaldo por reglas ETIQUETADO", () => {
  const roto: GestorAgent = { name: "llm:roto", turno: async () => { throw new Error("429 rate limit"); } };

  it("el turno cae a reglas con motor=fallback y deja el error", async () => {
    const g = gestorConRespaldo(roto, gestorScripted);
    const t = await g.turno(await entrada());
    expect(t.meta).toMatchObject({ motor: "fallback", error: expect.stringMatching(/429/) });
  });
  it("en un ciclo completo queda persistido como fallback (nunca como llm) y el flujo no se rompe", async () => {
    const ctx = await ctxTest({ gestor: gestorConRespaldo(roto, gestorScripted) });
    await crearCliente();
    await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    const r = await correr(ciclo(ctx, "T0001", { fase: "ejecutar" }));
    expect(r.fin.estado).not.toBe("error");
    const gestor = (await repos.gestiones.porCliente("T0001")).filter((g) => g.agente === "gestor");
    expect(gestor.length).toBeGreaterThan(0);
    expect(gestor.every((g) => g.motor === "fallback" && g.origen === "gestor_fallback")).toBe(true);
    const k = await repos.kpis.kpis();
    expect(k.llm.casosConLlm).toBe(0); // un fallback no cuenta como caso procesado con LLM
  });
  it("el cliente simulado también cae a reglas: una falla del LLM NO se disfraza de silencio", async () => {
    const c = clienteConRespaldo({ name: "llm", responder: async () => { throw new Error("timeout"); } }, { name: "reglas", responder: async () => "Ok, de acuerdo." });
    expect(await c.responder({ cliente: await crearCliente(), historial: [], ultimoMensaje: "hola", deHumano: false, hoy: "2026-10-14" })).toBe("Ok, de acuerdo.");
  });
});

describe("modo LLM sin credenciales", () => {
  it("no se etiqueta como LLM: corre reglas, lo declara y el stream lo avisa", async () => {
    const ctx = await getCtx("llm");
    expect(ctx.degradado).toMatch(/OPENROUTER_API_KEY/);
    expect(ctx.gestor.name).toMatch(/reglas/);
    await crearCliente();
    const c2 = { ...ctx, ahora: () => new Date(2026, 9, 14, 10, 0) };
    await correr(ciclo(c2, "T0001", { fase: "planificar" }));
    const r = await correr(conAviso(c2, ciclo(c2, "T0001", { fase: "ejecutar" })));
    expect(r.eventos[0]).toMatchObject({ titulo: "Modo LLM no disponible", estado: "rechazado" });
    const gestor = (await repos.gestiones.porCliente("T0001")).filter((g) => g.agente === "gestor");
    expect(gestor.every((g) => g.motor === "reglas")).toBe(true);
    expect((await repos.kpis.kpis()).llm).toMatchObject({ llamadas: 0, tokensIn: null, casosConLlm: 0 });
  });
});

describe("activación selectiva: el LLM no clasifica la cartera", () => {
  it("analizar y planificar los 25 primeros casos no hace ninguna llamada al LLM", async () => {
    const ctx = await ctxTest();
    for (const c of (await repos.cartera.list()).filter((x) => x.grupo === "tratamiento").slice(0, 25)) await correr(ciclo(ctx, c.cliente_id, { fase: "planificar" }));
    expect((await repos.kpis.kpis()).llm.llamadas).toBe(0);
  });
});
