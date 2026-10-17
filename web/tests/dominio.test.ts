import { beforeEach, describe, expect, it } from "vitest";
import { MODELO_METRICAS, modeloLogistico } from "@/lib/adapters/modelo-logistico";
import { repos } from "@/lib/container";
import { analizar } from "@/lib/core/analista";
import { estadoCaso } from "@/lib/core/estado";
import { ciclo } from "@/lib/core/orquestador";
import { violaHorario } from "@/lib/core/reglas";
import { validarPropuesta } from "@/lib/core/supervisor";
import { AHORA, correr, crearCliente, ctxTest, reiniciar } from "./helpers";

beforeEach(reiniciar);

describe("riesgo y datos sintéticos", () => {
  it("el análisis es determinístico y la prioridad respeta los umbrales", async () => {
    const todos = await repos.cartera.list();
    expect(todos).toHaveLength(800);
    for (const c of todos.slice(0, 60)) {
      const a = analizar(c, modeloLogistico), b = analizar(c, modeloLogistico);
      expect(a).toEqual(b);
      expect(a.prob_no_pago).toBeGreaterThanOrEqual(0);
      expect(a.prob_no_pago).toBeLessThanOrEqual(1);
      const p = modeloLogistico.probabilidad(c); // el umbral se aplica a la probabilidad sin redondear
      expect(a.prioridad).toBe(p >= 0.55 ? "alta" : p >= 0.3 ? "media" : "baja");
    }
  });
  it("que no llegue el sueldo nunca baja la probabilidad (el modelo recupera la señal plantada)", async () => {
    const base = await crearCliente({ cliente_id: "A1", sueldo_llego_mes: true });
    const sin = await crearCliente({ cliente_id: "A2", sueldo_llego_mes: false });
    expect(modeloLogistico.probabilidad(sin)).toBeGreaterThan(modeloLogistico.probabilidad(base));
  });
  it("las métricas del modelo declaran que son SINTÉTICAS y la cartera tiene los tres niveles", async () => {
    expect(MODELO_METRICAS.origen).toMatch(/SINTÉTICO/);
    const prios = new Set((await repos.cartera.list()).map((c) => analizar(c, modeloLogistico).prioridad));
    expect(prios).toEqual(new Set(["alta", "media", "baja"]));
  });
});

describe("horario y límite de contactos", () => {
  it("bloquea domingos y horas fuera de 08:00-20:00", async () => {
    const reglas = await (await ctxTest()).reglasRepo.todas();
    expect(violaHorario(reglas, "2026-10-14", "09:00")).toBeNull();
    expect(violaHorario(reglas, "2026-10-14", "21:00")).not.toBeNull();
    expect(violaHorario(reglas, "2026-10-14", "07:59")).not.toBeNull();
    expect(violaHorario(reglas, "2026-10-18", "10:00")).not.toBeNull(); // domingo
    expect(validarPropuesta({ canal: "sms", fecha: "2026-10-14", hora: "22:00", justificacion: "" }, reglas, 0).ok).toBe(false);
  });
  it("el límite semanal rechaza el contacto 4 y ninguna planificación cae fuera de horario", async () => {
    const reglas = await (await ctxTest()).reglasRepo.todas();
    expect(validarPropuesta({ canal: "sms", fecha: "2026-10-14", hora: "10:00", justificacion: "" }, reglas, 3).ok).toBe(false);
    const ctx = await ctxTest();
    for (const c of (await repos.cartera.list()).filter((x) => x.grupo === "tratamiento").slice(0, 25)) {
      await correr(ciclo(ctx, c.cliente_id, { fase: "planificar" }));
      const prog = (await repos.gestiones.porCliente(c.cliente_id)).find((g) => g.accion === "programar_contacto");
      const [f, h] = prog!.programado_para!.split("T");
      expect(violaHorario(reglas, f, h)).toBeNull();
    }
  });
  it("con 3 contactos en la semana el ciclo no vuelve a programar", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    for (let i = 0; i < 3; i++) await repos.gestiones.insertar({ cliente_id: "T0001", agente: "gestor", accion: "contacto_inicial", canal: "sms", mensaje: "x", resultado: "aprobado", motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false, justificacion: null, fecha: AHORA.toISOString() });
    const r = await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    expect(r.fin.estado).toBe("cerrado");
    expect((await repos.gestiones.porCliente("T0001")).some((g) => g.accion === "programar_contacto")).toBe(false);
  });
});

describe("estados reales del contacto", () => {
  it("planificar deja el contacto PROGRAMADO sin contactar a nadie; ejecutar lo envía (simulado)", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    const p = await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    expect(p.fin.estado).toBe("contacto_programado");
    let gs = await repos.gestiones.porCliente("T0001");
    expect(estadoCaso(gs).contacto).toBe("programado");
    expect(gs.some((g) => g.accion === "contacto_inicial" || g.agente === "cliente")).toBe(false);
    // idempotente: no duplica la programación
    await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    expect((await repos.gestiones.porCliente("T0001")).filter((g) => g.accion === "programar_contacto")).toHaveLength(1);

    const x = await correr(ciclo(ctx, "T0001", { fase: "ejecutar" }));
    gs = await repos.gestiones.porCliente("T0001");
    expect(gs.some((g) => g.accion === "contacto_inicial")).toBe(true);
    expect(x.eventos.map((e) => e.titulo).join("|")).toMatch(/SIMULACIÓN: llega la fecha/);
    expect(gs.filter((g) => g.agente === "gestor").every((g) => g.motor === "reglas")).toBe(true); // sin LLM no se etiqueta LLM
  });
  it("ejecutar sin programación previa se rechaza", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    const r = await correr(ciclo(ctx, "T0001", { fase: "ejecutar" }));
    expect(r.fin.estado).toBe("error");
  });
});

describe("caso sin respuesta", () => {
  it("registra el silencio, programa UN reintento permitido y luego deriva a una persona (no insiste)", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    const a = await correr(ciclo(ctx, "T0001", { fase: "ejecutar", silencio: true }));
    expect(a.fin.estado).toBe("reintento_programado");
    let gs = await repos.gestiones.porCliente("T0001");
    expect(gs.filter((g) => g.accion === "sin_respuesta")).toHaveLength(1);
    expect(estadoCaso(gs).contacto).toBe("programado");
    const reint = gs.filter((g) => g.accion === "programar_contacto").at(-1)!;
    expect(reint.resultado).toBe("reintento");

    const b = await correr(ciclo(ctx, "T0001", { fase: "ejecutar", silencio: true }));
    expect(b.fin.estado).toBe("esperando_humano");
    gs = await repos.gestiones.porCliente("T0001");
    expect(gs.filter((g) => g.accion === "sin_respuesta")).toHaveLength(2);
    expect(estadoCaso(gs)).toMatchObject({ esperandoHumano: true, intentosSinRespuesta: 2, contacto: "escalado" });
    // ya derivado: otro ciclo no vuelve a contactar
    const c = await correr(ciclo(ctx, "T0001", { fase: "todo" }));
    expect(c.fin.estado).toBe("esperando_humano");
    expect((await repos.gestiones.porCliente("T0001")).filter((g) => g.accion === "contacto_inicial")).toHaveLength(2);
  });
});
