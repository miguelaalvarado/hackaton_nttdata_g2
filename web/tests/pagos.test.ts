import { beforeEach, describe, expect, it } from "vitest";
import { repos } from "@/lib/container";
import { ciclo, turnoHumano } from "@/lib/core/orquestador";
import { confirmarPago } from "@/lib/core/pagos";
import { seguimientoCliente } from "@/lib/core/seguimiento";
import { correr, crearCliente, ctxTest, reiniciar } from "./helpers";

beforeEach(reiniciar);

/** Cliente con una promesa registrada (el flujo clásico de iliquidez: 2 pagos de 200). */
async function conPromesa() {
  const ctx = await ctxTest();
  await crearCliente({ sim_escenario: "iliquidez" });
  const r = await correr(ciclo(ctx, "T0001", { fase: "todo" }));
  expect(r.fin.estado).toBe("promesa_registrada");
  const [p] = (await repos.gestiones.porCliente("T0001")).filter((g) => g.accion === "promesa");
  return { ctx, p };
}

describe("P0-A · promesa ≠ pago", () => {
  it("registrar una promesa no cambia saldo ni crea pagos", async () => {
    const { p } = await conPromesa();
    expect(p.estado_promesa).toBe("pendiente");
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(850);
    expect(await repos.pagos.porCliente("T0001")).toHaveLength(0);
    expect((await repos.kpis.kpis()).pagos).toEqual({ simulados: { n: 0, monto: 0 }, confirmados: { n: 0, monto: 0 } });
  });
  it("el seguimiento simulado NUNCA mueve el saldo ni crea un pago confirmado; lo etiqueta como simulado", async () => {
    const { ctx } = await conPromesa();
    await correr(seguimientoCliente(ctx, "T0001"));
    const gs = await repos.gestiones.porCliente("T0001");
    const prom = gs.find((g) => g.accion === "promesa")!;
    expect(["cumplida_simulada", "rota"]).toContain(prom.estado_promesa); // jamás "cumplida" sin un pago confirmado
    expect(gs.some((g) => g.accion === "fecha_promesa_alcanzada")).toBe(true);
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(850);
    const pagos = await repos.pagos.porCliente("T0001");
    expect(pagos.every((x) => x.estado === "simulado" && x.origen === "simulador")).toBe(true);
    const k = await repos.kpis.kpis();
    expect(k.pagos.confirmados.n).toBe(0);
    expect(k.promesas.cumplidas).toBe(0);
    expect(k.promesas.cumplidasSimuladas + k.promesas.rotas).toBe(1);
  });
  it("el seguimiento es idempotente: repetirlo no duplica el pago simulado", async () => {
    const { ctx } = await conPromesa();
    await correr(seguimientoCliente(ctx, "T0001"));
    const antes = (await repos.pagos.porCliente("T0001")).length;
    const r = await correr(seguimientoCliente(ctx, "T0001"));
    expect(r.fin.detalle).toMatch(/Sin promesas pendientes/);
    expect(await repos.pagos.porCliente("T0001")).toHaveLength(antes);
  });
});

describe("pagos confirmados (evento autorizado)", () => {
  it("descuenta el saldo UNA vez: un evento duplicado no descuenta dos veces", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    const a = await confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-100", monto: 300 });
    expect(a.resultado).toMatchObject({ estado: "aplicado", saldo_restante: 550 });
    const b = await confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-100", monto: 300 });
    expect(b.resultado.estado).toBe("duplicado");
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(550);
    expect(await repos.pagos.porCliente("T0001")).toHaveLength(1);
  });
  it("llamadas concurrentes con la misma referencia descuentan una sola vez", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    const rs = await Promise.all([1, 2, 3, 4].map(() => confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-C", monto: 100 })));
    expect(rs.filter((x) => x.resultado.estado === "aplicado")).toHaveLength(1);
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(750);
  });
  it("no permite saldos negativos ni montos inválidos", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    expect((await confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-X", monto: 851 })).resultado).toMatchObject({ estado: "rechazado" });
    expect((await confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-Y", monto: -5 })).resultado.estado).toBe("rechazado");
    expect((await confirmarPago(ctx, { clienteId: "NOEXISTE", referencia: "OP-Z", monto: 5 })).resultado.estado).toBe("rechazado");
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(850);
    expect(await repos.pagos.porCliente("T0001")).toHaveLength(0);
  });
  it("un pago confirmado cumple la promesa cubierta y, si salda la deuda, cancela seguimientos obsoletos y cierra el caso", async () => {
    const { ctx } = await conPromesa();
    const prom = (await repos.gestiones.porCliente("T0001")).find((g) => g.accion === "promesa")!;
    const r1 = await confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-1", monto: prom.monto_promesa! });
    expect(r1.efectos.join()).toMatch(/cumplida con pago confirmado/);
    expect((await repos.gestiones.porCliente("T0001")).find((g) => g.accion === "promesa")!.estado_promesa).toBe("cumplida");
    expect((await repos.kpis.kpis()).pagos.confirmados.n).toBe(1);
    // segunda promesa pendiente + pago que salda la deuda → se cancela
    for (const m of [500, 300]) // dos promesas pendientes que suman más que el saldo restante (650)
      await repos.gestiones.insertar({ cliente_id: "T0001", agente: "gestor", accion: "promesa", canal: "sms", mensaje: "x", resultado: "promesa_registrada", motivo_no_pago: "iliquidez", monto_promesa: m, fecha_promesa: "2026-10-30", estado_promesa: "pendiente", derivado_humano: false, justificacion: null });
    const saldo = (await repos.cartera.get("T0001"))!.saldo_deuda;
    expect(saldo).toBe(650);
    const r2 = await confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-2", monto: saldo });
    expect(r2.resultado).toMatchObject({ estado: "aplicado", saldo_restante: 0 });
    expect(r2.efectos.join()).toMatch(/cancelada/);
    expect(await repos.gestiones.promesasPendientes("T0001")).toHaveLength(0);
    const gs = await repos.gestiones.porCliente("T0001");
    expect(gs.at(-1)!.accion).toBe("cierre_por_pago");
    expect((await correr(ciclo(ctx, "T0001", { fase: "todo" }))).fin.estado).not.toBe("promesa_registrada");
  });
  it("la conciliación levanta el bloqueo de 'ya pagué'", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    await correr(ciclo(ctx, "T0001", { fase: "ejecutar", respuestasCliente: ["Ya pagué ayer"] }));
    const r = await correr(ciclo(ctx, "T0001", { fase: "todo" }));
    expect(r.fin.estado).toBe("bloqueado");
    await confirmarPago(ctx, { clienteId: "T0001", referencia: "OP-B", monto: 400 });
    const { estadoCaso } = await import("@/lib/core/estado");
    expect(estadoCaso(await repos.gestiones.porCliente("T0001")).bloqueo).toBeNull();
  });
});

describe("el asesor no puede registrar pagos", () => {
  it("no existe ninguna acción del asesor que modifique saldos", async () => {
    const ctx = await ctxTest();
    await crearCliente();
    await correr(ciclo(ctx, "T0001", { fase: "planificar" }));
    await correr(ciclo(ctx, "T0001", { fase: "ejecutar", respuestasCliente: ["¿Pueden bajarme la tasa?"] }));
    await correr(turnoHumano(ctx, "T0001", { accion: "enviar", mensaje: "Hola Ana, ya recibimos tu pago de S/ 850." }, { respuestasCliente: ["Gracias"] }));
    expect((await repos.cartera.get("T0001"))!.saldo_deuda).toBe(850);
    expect(await repos.pagos.porCliente("T0001")).toHaveLength(0);
  });
});
