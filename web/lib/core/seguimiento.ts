import { borradorSupervisor } from "./borrador-supervisor";
import { ciclo, turnoHumano, type Ctx } from "./orquestador";
import type { ActorId, Cliente, EventoStream } from "./types";

/**
 * SIMULACIÓN del mundo real: decide si el cliente cumple su promesa y si paga a tiempo.
 * Es determinística por cliente. Las probabilidades son supuestos de la demo: la métrica resultante mide el
 * efecto de ESTE simulador, no un resultado real.
 */
const hash01 = (s: string) => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h / 4294967296;
};
/** Cumple más si el Gestor identificó el motivo real del cliente y le ofreció algo que encaja. */
export const P_CUMPLE = { motivoAcertado: 0.6, motivoErrado: 0.3 };
export const promesaCumplida = (c: Cliente, motivoGestor: string | null) =>
  hash01(`${c.cliente_id}:promesa`) < (motivoGestor === c.sim_escenario ? P_CUMPLE.motivoAcertado : P_CUMPLE.motivoErrado);

type Ev = EventoStream;
const mk = (n: { v: number }, de: ActorId, a: ActorId, tipo: "consulta" | "seguimiento" | "registro", titulo: string, texto?: string, estado: "ok" | "rechazado" | "info" = "info"): Ev =>
  ({ tipo: "evento", evento: { id: ++n.v, de, a, tipo, titulo, texto, estado } });

/**
 * Avanza al día de la promesa (SIMULACIÓN de calendario). Estados: pendiente → fecha alcanzada →
 *  - `cumplida`: hay un pago CONFIRMADO que la cubre;
 *  - `cumplida_simulada`: el simulador genera un pago SIMULADO (no mueve saldo, no es recuperación observada);
 *  - `rota`: no hubo pago.
 * Una promesa nunca se convierte en pago confirmado por sí sola.
 */
export async function* seguimientoCliente(ctx: Ctx, clienteId: string): AsyncGenerator<Ev> {
  const n = { v: 0 };
  const c = await ctx.cartera.get(clienteId);
  if (!c) { yield { tipo: "fin", estado: "error", detalle: "Cliente no existe" }; return; }
  const pendientes = await ctx.gestiones.promesasPendientes(clienteId);
  if (!pendientes.length) { yield { tipo: "fin", estado: "cerrado", detalle: "Sin promesas pendientes." }; return; }
  let ultimo: "cumplida" | "cumplida_simulada" | "rota" = "rota";
  const confirmados = (await ctx.pagos.porCliente(clienteId)).filter((x) => x.estado === "confirmado");
  for (const p of pendientes) {
    yield mk(n, "supervisor", "bd", "seguimiento", `SIMULACIÓN: llega la fecha de la promesa (${p.fecha_promesa})`, `Promesa #${p.gestion_id} por S/ ${p.monto_promesa}.`);
    await ctx.gestiones.insertar({ cliente_id: clienteId, agente: "supervisor", accion: "fecha_promesa_alcanzada", canal: null, mensaje: null, resultado: "fecha_alcanzada", motivo_no_pago: p.motivo_no_pago,
      monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false, justificacion: `Se alcanzó la fecha (${p.fecha_promesa}) de la promesa #${p.gestion_id} por S/ ${p.monto_promesa}.`, origen: "supervisor", aprobacion: "no_aplica", motor: "reglas" });
    yield mk(n, "supervisor", "bd", "consulta", `¿Hay un pago CONFIRMADO de S/ ${p.monto_promesa}?`, "Consulta la tabla de pagos confirmados por conciliación.");
    const cubierto = confirmados.some((x) => x.monto >= (p.monto_promesa ?? Infinity) && x.fecha >= p.fecha);
    if (cubierto) {
      ultimo = "cumplida";
      yield mk(n, "bd", "supervisor", "seguimiento", "Pago confirmado encontrado", "Hay un pago conciliado que cubre la promesa.", "ok");
    } else {
      const ok = promesaCumplida(c, p.motivo_no_pago);
      if (ok) {
        ultimo = "cumplida_simulada";
        await ctx.pagos.registrar({ cliente_id: clienteId, referencia: `SIM-${p.gestion_id}`, monto: p.monto_promesa ?? 0, origen: "simulador", promesa_id: p.gestion_id });
        yield mk(n, "bd", "supervisor", "seguimiento", "SIMULACIÓN: el simulador genera un pago simulado", "No es un pago confirmado ni una conciliación bancaria: no cambia el saldo.", "info");
      } else {
        ultimo = "rota";
        yield mk(n, "bd", "supervisor", "seguimiento", "No se encontró el pago", "Llegó la fecha y no hay pago: promesa incumplida. Siguiente paso permitido: nuevo contacto según reglas o derivación a un asesor.", "rechazado");
      }
    }
    await ctx.gestiones.actualizarPromesa(p.gestion_id, ultimo);
    await ctx.gestiones.insertar({
      cliente_id: clienteId, agente: "supervisor", accion: "seguimiento", canal: null, mensaje: null, resultado: ultimo, motivo_no_pago: p.motivo_no_pago,
      monto_promesa: p.monto_promesa, fecha_promesa: p.fecha_promesa, estado_promesa: ultimo, derivado_humano: false,
      justificacion: `Promesa #${p.gestion_id} marcada como ${ultimo.replace("_", " ")}.`, origen: "supervisor", aprobacion: "no_aplica", motor: "reglas",
    });
    yield mk(n, "supervisor", "bd", "registro", `Marca la promesa como ${ultimo.replace("_", " ")}`, undefined, ultimo === "rota" ? "rechazado" : "ok");
  }
  // pago_a_tiempo alimenta el lift SIMULADO del dashboard; solo una promesa cumplida (confirmada o simulada) lo pone en true.
  await ctx.cartera.setPagoATiempo(clienteId, ultimo !== "rota" ? true : c.sim_pago_base);
  yield { tipo: "fin", estado: "cerrado", detalle: `Promesa ${ultimo.replace("_", " ")}` };
}

/** Cierre de mes simulado: resuelve todas las promesas y fija `pago_a_tiempo` de toda la cartera. */
export async function cerrarMes(ctx: Ctx) {
  const clientes = await ctx.cartera.list();
  let cumplidas = 0, rotas = 0;
  for (const c of clientes) {
    const pend = await ctx.gestiones.promesasPendientes(c.cliente_id);
    if (pend.length) {
      for await (const ev of seguimientoCliente(ctx, c.cliente_id)) void ev;
      const g = await ctx.gestiones.porCliente(c.cliente_id);
      const ult = [...g].reverse().find((x) => x.accion === "seguimiento");
      if (ult?.estado_promesa === "cumplida" || ult?.estado_promesa === "cumplida_simulada") cumplidas++; else rotas++;
    } else {
      const g = await ctx.gestiones.porCliente(c.cliente_id);
      const cumplio = g.some((x) => x.accion === "promesa" && (x.estado_promesa === "cumplida" || x.estado_promesa === "cumplida_simulada"));
      await ctx.cartera.setPagoATiempo(c.cliente_id, cumplio ? true : c.sim_pago_base);
    }
  }
  return { clientes: clientes.length, promesasCumplidasSimuladas: cumplidas, promesasRotas: rotas };
}

/** Procesa N clientes de alta prioridad (tratamiento y sin gestión previa) sin streaming; el humano usa el borrador del Gestor. */
export async function procesarLote(ctx: Ctx, n: number) {
  const clientes = (await ctx.cartera.list()).filter((c) => c.grupo === "tratamiento");
  // Prioriza por riesgo del modelo (el Analista aún no corrió: se calcula aquí para elegir)
  const ordenados = clientes
    .map((c) => ({ c, p: ctx.modelo.probabilidad(c) }))
    .sort((a, b) => b.p - a.p)
    .map((x) => x.c);
  const res = { procesados: 0, promesas: 0, derivados: 0, derivadosPendientes: 0, cerrados: 0 };
  for (const c of ordenados) {
    if (res.procesados >= n) break;
    if ((await ctx.gestiones.porCliente(c.cliente_id)).length) continue;
    let fin: Extract<EventoStream, { tipo: "fin" }> | null = null;
    let borrador: string | null = null;
    for await (const ev of ciclo(ctx, c.cliente_id)) {
      if (ev.tipo === "fin") fin = ev;
      else if (ev.evento.tipo === "escalamiento") borrador = (ev.evento.datos as { borrador?: string } | undefined)?.borrador ?? borrador;
    }
    res.procesados++;
    if (fin?.estado === "esperando_humano") {
      res.derivados++;
      for await (const ev of turnoHumano(ctx, c.cliente_id, { accion: "enviar", mensaje: borrador || borradorSupervisor(c.nombre) })) {
        if (ev.tipo === "fin") fin = ev;
      }
    }
    if (fin?.estado === "promesa_registrada") res.promesas++;
    else if (fin?.estado === "esperando_humano") res.derivadosPendientes++; // el acuerdo no pasó las validaciones: sigue con una persona
    else res.cerrados++;
  }
  return res;
}
