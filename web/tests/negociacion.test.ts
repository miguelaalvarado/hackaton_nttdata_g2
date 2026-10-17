import { beforeEach, describe, expect, it } from "vitest";
import { repos } from "@/lib/container";
import { estadoCaso } from "@/lib/core/estado";
import { guardrailSolicitud, interpretarSolicitud } from "@/lib/core/negociacion";
import { ciclo, turnoHumano, type Ctx } from "@/lib/core/orquestador";
import type { GestorAgent } from "@/lib/core/ports";
import { lenguajeNoAutorizado } from "@/lib/core/supervisor";
import type { GestorResultado } from "@/lib/core/types";
import { correr, crearCliente, ctxTest, reiniciar, textos } from "./helpers";

beforeEach(reiniciar);

/** Ejecuta el contacto completo con lo que "dice" el cliente (entrada manual de la demo) usando el Gestor por reglas. */
async function conversar(texto: string, c: Parameters<typeof crearCliente>[0] = {}, over: Partial<Ctx> = {}) {
  const ctx = await ctxTest(over);
  const cli = await crearCliente(c);
  await correr(ciclo(ctx, cli.cliente_id, { fase: "planificar" }));
  const r = await correr(ciclo(ctx, cli.cliente_id, { fase: "ejecutar", respuestasCliente: [texto] }));
  const gs = await repos.gestiones.porCliente(cli.cliente_id);
  return { ctx, r, gs, estado: estadoCaso(gs), ultimoGestor: [...gs].reverse().find((g) => g.agente === "gestor")! };
}

describe("interpretación de la solicitud", () => {
  it("extrae plazos, montos y pedidos no autorizados", () => {
    expect(interpretarSolicitud("Necesito 30 días para completar el pago").diasSolicitados).toBe(30);
    expect(interpretarSolicitud("me depositan la próxima semana").diasSolicitados).toBe(7);
    expect(interpretarSolicitud("Debo S/850, pero ahora puedo pagar S/300").montoDisponible).toBe(300);
    expect(interpretarSolicitud("¿Pueden bajarme la tasa?").pideTasa).toBe(true);
    expect(interpretarSolicitud("Ya pagué ayer").pagoDeclarado).toBe(true);
    expect(interpretarSolicitud("Esa deuda no es mía").desconoceDeuda).toBe(true);
    expect(interpretarSolicitud("No me contacten más").noContactar).toBe(true);
    expect(interpretarSolicitud("Se me pasó la fecha, disculpa").pagoDeclarado).toBe(false);
  });
  it("el lenguaje no autorizado se detecta, pero una negación explícita no es una promesa", () => {
    expect(lenguajeNoAutorizado("Te ofrezco un descuento del 20 %")).toBe("descuento");
    expect(lenguajeNoAutorizado("Podemos refinanciar tu deuda")).toBeTruthy();
    expect(lenguajeNoAutorizado("No tengo una política que me permita ofrecerte una reducción de tasa.")).toBeNull();
    expect(lenguajeNoAutorizado("Podemos mover la fecha hasta 7 días.")).toBeNull();
  });
});

describe("escenarios de negociación (A-G) con estado persistente", () => {
  it.each([
    "Necesito 30 días para completar el pago",
    "Me quedé sin trabajo",
    "Prefiero revisar mi situación con una persona",
  ])("el borrador de derivación habla como Supervisor al cliente: %s", async (respuesta) => {
    const { r } = await conversar(respuesta, { nombre: "Miguel Soto", dias_atraso: 45 });
    expect(r.fin.estado).toBe("esperando_humano");
    const derivacion = r.eventos.find((e) => e.tipo === "escalamiento" && (e.datos as { borrador?: string })?.borrador);
    const borrador = (derivacion?.datos as { borrador: string })?.borrador;
    expect(borrador).toMatch(/^Hola Miguel, soy el Supervisor de tu banco\./);
    expect(borrador).toContain("tu caso");
    expect(borrador).not.toMatch(/soy asesor|soy tu asesor/i);
  });

  it("A · retraso salarial: identifica el motivo, ofrece SOLO la regla autorizada y la promesa respeta el máximo de 7 días", async () => {
    const { r, gs } = await conversar("No me pagaron este mes. Me depositan la próxima semana.", { sim_escenario: "retraso_ingresos", sueldo_llego_mes: false });
    const oferta = gs.find((g) => g.agente === "gestor" && g.motivo_no_pago === "retraso_ingresos" && g.mensaje?.includes("hasta 7 días"));
    expect(oferta).toBeTruthy();
    expect(r.fin.estado).toBe("promesa_registrada"); // el cliente simulado acepta la oferta autorizada
    const p = gs.find((g) => g.accion === "promesa")!;
    expect(p).toMatchObject({ origen: "gestor_reglas", aprobacion: "validada_supervisor", estado_promesa: "pendiente" });
    expect(p.fecha_promesa! <= "2026-10-21").toBe(true); // ≤ 7 días desde 2026-10-14
    expect(p.monto_promesa!).toBeLessThanOrEqual(850);
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(850); // una promesa no mueve el saldo
  });
  it("B · pago parcial: reconoce el monto, NO inventa un acuerdo y deriva a un asesor", async () => {
    const { r, estado, ultimoGestor, gs } = await conversar("Debo S/850, pero ahora puedo pagar S/300", { saldo_deuda: 850, monto_cuota: 850 });
    expect(r.fin.estado).toBe("esperando_humano");
    expect(ultimoGestor.motivo_no_pago).toBe("solicitud_fuera_de_politica");
    expect(ultimoGestor.mensaje).toMatch(/S\/ 300/);
    expect(ultimoGestor.mensaje).toMatch(/todavía no queda aprobado/);
    expect(gs.some((g) => g.accion === "promesa")).toBe(false);
    expect(estado.esperandoHumano).toBe(true);
  });
  it("C · pide 30 días y las reglas permiten 7: no ofrece 30, explica el límite y escala", async () => {
    const { r, ultimoGestor, gs } = await conversar("Necesito 30 días para completar el pago");
    expect(r.fin.estado).toBe("esperando_humano");
    expect(ultimoGestor.mensaje).toMatch(/hasta 7 días/);
    expect(ultimoGestor.mensaje).toMatch(/30 días/);
    expect(ultimoGestor.derivado_humano).toBe(true);
    expect(gs.some((g) => g.accion === "promesa")).toBe(false);
  });
  it("D · reducción de tasa: no promete nada y escala", async () => {
    const { r, ultimoGestor, gs } = await conversar("¿Pueden bajarme la tasa?");
    expect(r.fin.estado).toBe("esperando_humano");
    expect(ultimoGestor.motivo_no_pago).toBe("solicitud_fuera_de_politica");
    expect(lenguajeNoAutorizado(ultimoGestor.mensaje!)).toBeNull();
    expect(ultimoGestor.mensaje).toMatch(/no es una promesa/);
    expect(gs.some((g) => g.accion === "promesa")).toBe(false);
  });
  it("E · desconoce la deuda: suspende la negociación y bloquea nuevas gestiones", async () => {
    const { ctx, r, estado, gs } = await conversar("Esa deuda no es mía");
    expect(r.fin.estado).toBe("esperando_humano");
    expect(estado.bloqueo).toBe("disputa");
    expect(gs.some((g) => g.accion === "promesa")).toBe(false);
    const otra = await correr(ciclo(ctx, "T0001", { fase: "todo" }));
    expect(otra.fin.estado).toBe("bloqueado");
  });
  it("G · 'ya pagué': NO es un pago confirmado; queda pendiente de conciliación y bloquea gestiones", async () => {
    const { ctx, r, estado, gs } = await conversar("Ya pagué ayer, revisen por favor");
    expect(r.fin.estado).toBe("esperando_humano");
    expect(estado.bloqueo).toBe("pago_declarado");
    expect(gs.find((g) => g.accion === "pago_declarado")?.resultado).toBe("pendiente_conciliacion");
    expect((await repos.pagos.porCliente("T0001"))).toHaveLength(0);
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(850); // la declaración no mueve el saldo
    expect((await correr(ciclo(ctx, "T0001", { fase: "todo" }))).fin.estado).toBe("bloqueado");
  });
  it("opt-out: cierra el caso y no se vuelve a contactar", async () => {
    const { ctx, r, estado } = await conversar("No me contacten más por favor");
    expect(r.fin.estado).toBe("cerrado");
    expect(estado.bloqueo).toBe("no_contactar");
    expect((await correr(ciclo(ctx, "T0001", { fase: "planificar" }))).fin.estado).toBe("bloqueado");
  });
  it("el guardrail es independiente del Gestor: un LLM que ofrece 30 días es corregido por el Supervisor", async () => {
    const malo: GestorAgent = {
      name: "llm-malo",
      async turno(i) {
        if (!i.historial.some((t) => t.rol === "cliente")) return { accion: "preguntar", mensaje: "Hola Ana, ¿qué pasó con tu cuota?", motivo_no_pago: "desconocido", regla_id: null, monto_promesa: null, fecha_promesa: null, justificacion: "x", resumen_humano: null, borrador_humano: null, meta: { motor: "llm" } };
        return { accion: "registrar_promesa", mensaje: "Perfecto, te damos 30 días y una tasa menor.", motivo_no_pago: "iliquidez", regla_id: 7, monto_promesa: 400, fecha_promesa: "2026-11-13", justificacion: "x", resumen_humano: null, borrador_humano: null, meta: { motor: "llm" } };
      },
    };
    const { r, gs } = await conversar("Necesito 30 días para pagar", {}, { gestor: malo });
    expect(r.fin.estado).toBe("esperando_humano");
    expect(gs.some((g) => g.accion === "promesa")).toBe(false);
    expect(textos(r.eventos)).toMatch(/Guardrail/);
    expect(gs.filter((g) => g.agente === "gestor").at(-1)!.motor).toBe("llm"); // el motor sigue siendo el real
  });
});

describe("P0-B · todo acuerdo posterior al asesor se revalida", () => {
  /** Gestor que, tras el asesor, intenta registrar la promesa que se le indique. */
  const gestorConPromesa = (p: Partial<GestorResultado>): GestorAgent => ({
    name: "stub",
    async turno(i) {
      // Antes de que intervenga el asesor se comporta de forma neutra; solo tras el asesor intenta registrar la promesa indicada.
      if (!i.humanoActivo) return { accion: "preguntar", mensaje: "Hola Ana, ¿qué pasó con tu cuota?", motivo_no_pago: "desconocido", regla_id: null, monto_promesa: null, fecha_promesa: null, justificacion: "x", resumen_humano: null, borrador_humano: null, meta: { motor: "reglas" } };
      return { accion: "registrar_promesa", mensaje: "resumen", motivo_no_pago: "desempleo", regla_id: 4, monto_promesa: 200, fecha_promesa: "2026-10-20", justificacion: "acuerdo", resumen_humano: null, borrador_humano: null, meta: { motor: "reglas" }, ...p };
    },
  });
  async function derivadoA(over: Partial<Ctx>, c = {}) {
    const ctx = await ctxTest(over);
    await crearCliente({ ...c });
    // Deja el caso derivado a un asesor (pidió reducción de tasa).
    await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    await correr(ciclo(ctx, "T0001", { fase: "ejecutar", respuestasCliente: ["¿Pueden bajarme la tasa?"] }));
    return ctx;
  }
  const humano = (ctx: Ctx) => correr(turnoHumano(ctx, "T0001", { accion: "enviar", mensaje: "Hola Ana, soy asesor del banco. Veamos cómo ayudarte." }, { respuestasCliente: ["Sí, acepto pagar la mitad."] }));
  const promesas = async () => (await repos.gestiones.porCliente("T0001")).filter((g) => g.accion === "promesa");

  it("acepta un acuerdo que cumple las reglas y registra origen y aprobación", async () => {
    const ctx = await derivadoA({ gestor: gestorConPromesa({}) });
    const r = await humano(ctx);
    expect(r.fin.estado).toBe("promesa_registrada");
    const [p] = await promesas();
    expect(p).toMatchObject({ origen: "asesor_humano", aprobacion: "validada_supervisor", estado_promesa: "pendiente", monto_promesa: 200 });
  });
  it.each([
    ["monto mayor que la deuda", { monto_promesa: 900 }, /supera el saldo/],
    ["monto cero", { monto_promesa: 0 }, /monto_promesa válido/],
    ["fecha en el pasado", { fecha_promesa: "2026-10-01" }, /pasado/],
    ["fecha mal formada", { fecha_promesa: "mañana" }, /YYYY-MM-DD/],
    ["regla inexistente", { regla_id: 99 }, /no existe en la tabla de reglas/],
    ["regla que no aplica al motivo", { regla_id: 3, motivo_no_pago: "desempleo" }, /no aplica/],
    ["regla nula", { regla_id: null }, /no existe en la tabla de reglas/],
    ["plazo mayor al de la regla", { regla_id: 7, motivo_no_pago: "iliquidez", fecha_promesa: "2026-11-20" }, /hasta 7 días/],
  ] as const)("rechaza: %s", async (_n, ov, re) => {
    const ctx = await derivadoA({ gestor: gestorConPromesa(ov as Partial<GestorResultado>) });
    const r = await humano(ctx);
    expect(r.fin.estado).toBe("esperando_humano");
    expect(r.fin.detalle).toMatch(re);
    expect(await promesas()).toHaveLength(0);
    const rechazo = (await repos.gestiones.porCliente("T0001")).find((g) => g.accion === "validar" && g.origen === "asesor_humano");
    expect(rechazo?.aprobacion).toBe("rechazada_supervisor");
  });
  it("con una disputa abierta no se registra promesa hasta que una persona la resuelve", async () => {
    const ctx = await ctxTest({ gestor: gestorConPromesa({ motivo_no_pago: "desempleo", regla_id: 4 }) });
    await crearCliente();
    await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    await correr(ciclo(ctx, "T0001", { fase: "ejecutar", respuestasCliente: ["Esa deuda no es mía"] }));
    expect(estadoCaso(await repos.gestiones.porCliente("T0001")).bloqueo).toBe("disputa");
    const r1 = await humano(ctx);
    expect(r1.fin.estado).toBe("esperando_humano");
    expect(r1.fin.detalle).toMatch(/disputa/i);
    expect(await promesas()).toHaveLength(0);
    // levantar el bloqueo exige una nota de verificación
    expect((await correr(turnoHumano(ctx, "T0001", { accion: "levantar_bloqueo", nota: "ok" }))).fin.detalle).toMatch(/nota/);
    await correr(turnoHumano(ctx, "T0001", { accion: "levantar_bloqueo", nota: "Verificación documental: la deuda es del cliente." }));
    expect(estadoCaso(await repos.gestiones.porCliente("T0001")).bloqueo).toBeNull();
    expect((await humano(ctx)).fin.estado).toBe("promesa_registrada");
  });
  it("un mensaje del asesor que promete un descuento se rechaza y no sale", async () => {
    const ctx = await derivadoA({});
    const r = await correr(turnoHumano(ctx, "T0001", { accion: "enviar", mensaje: "Hola Ana, te ofrezco un descuento del 30 % si pagas hoy." }));
    expect(r.fin.detalle).toMatch(/condición que no existe/);
    expect((await repos.gestiones.porCliente("T0001")).some((g) => g.agente === "humano" && g.accion === "conversar")).toBe(false);
  });
  it("un asesor solo puede actuar sobre casos que le fueron derivados", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    const r = await correr(turnoHumano(ctx, "T0001", { accion: "enviar", mensaje: "Hola, soy un asesor." }));
    expect(r.fin).toMatchObject({ estado: "error" });
    expect(await repos.gestiones.porCliente("T0001")).toHaveLength(0);
  });
  it("el guardrail también actúa tras el asesor (cliente dice 'ya pagué')", async () => {
    const ctx = await derivadoA({ gestor: gestorConPromesa({}) });
    const r = await correr(turnoHumano(ctx, "T0001", { accion: "enviar", mensaje: "Hola Ana, soy asesor del banco." }, { respuestasCliente: ["Ya pagué ayer, no sé por qué me escriben"] }));
    expect(r.fin.estado).toBe("esperando_humano");
    expect(await promesas()).toHaveLength(0);
    expect(estadoCaso(await repos.gestiones.porCliente("T0001")).bloqueo).toBe("pago_declarado");
  });
});

describe("guardrail puro", () => {
  it("un pago parcial exactamente igual a la mitad de la cuota SÍ es la opción autorizada (fraccionar en 2)", async () => {
    const reglas = await (await ctxTest()).reglasRepo.todas();
    const c = await crearCliente({ monto_cuota: 400, dias_atraso: 10 });
    expect(guardrailSolicitud("puedo pagar S/200 ahora", c, reglas)).toBeNull();
    expect(guardrailSolicitud("puedo pagar S/150 ahora", c, reglas)?.motivo).toBe("solicitud_fuera_de_politica");
    expect(guardrailSolicitud("puedo pagar S/400 ahora", c, reglas)).toBeNull(); // la cuota completa no es un pago parcial
  });
});
