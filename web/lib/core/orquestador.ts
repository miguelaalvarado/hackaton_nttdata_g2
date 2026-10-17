import { analizar, proponerSlot } from "./analista";
import type { CarteraRepository, ClienteSimulator, GestionRepository, GestorAgent, ReglaRepository, RiskModel, ToneChecker } from "./ports";
import { isoDate, maxContactosSemana, motivosEscalamiento } from "./reglas";
import { contactosPrevios, validarMensaje, validarPropuesta } from "./supervisor";
import type { ActorId, Cliente, ClientePublico, EventoAgente, EventoStream, Gestion, GestorTurn, Turno } from "./types";

export type Ctx = {
  cartera: CarteraRepository;
  gestiones: GestionRepository;
  reglasRepo: ReglaRepository;
  modelo: RiskModel;
  gestor: GestorAgent;
  cliente: ClienteSimulator;
  tono: ToneChecker;
  ahora: () => Date;
};

type Ev = Omit<EventoAgente, "id">;
class Secuencia {
  n = 0;
  ev(e: Ev): EventoStream {
    return { tipo: "evento", evento: { ...e, id: ++this.n } };
  }
}
const e = (de: ActorId, a: ActorId, tipo: Ev["tipo"], titulo: string, texto?: string, estado: Ev["estado"] = "info", datos?: unknown): Ev =>
  ({ de, a, tipo, titulo, texto, estado, datos });

const publico = (c: Cliente): ClientePublico => {
  const { sim_escenario: _a, sim_pago_base: _b, pago_a_tiempo: _c, ...p } = c;
  return p;
};
const MAX_REINTENTOS = 2;

export const historialDe = (gs: Gestion[]): Turno[] =>
  gs.flatMap((g): Turno[] => {
    if (!g.mensaje) return [];
    if (g.agente === "gestor" && ["contacto_inicial", "conversar"].includes(g.accion)) return [{ rol: "gestor", texto: g.mensaje }];
    if (g.agente === "humano" && g.accion === "conversar") return [{ rol: "humano", texto: g.mensaje }];
    if (g.agente === "cliente" && g.accion === "responder") return [{ rol: "cliente", texto: g.mensaje }];
    return [];
  });

/** Ciclo completo: Analista → Supervisor → Gestor ⇄ Cliente (cada mensaje validado por el Supervisor) → promesa / humano. */
export async function* ciclo(ctx: Ctx, clienteId: string, maxTurnos = 4): AsyncGenerator<EventoStream> {
  const s = new Secuencia();
  const cliente = await ctx.cartera.get(clienteId);
  if (!cliente) { yield { tipo: "fin", estado: "error", detalle: `Cliente ${clienteId} no existe` }; return; }
  const reglas = await ctx.reglasRepo.todas();
  const ahora = ctx.ahora();
  const hoy = isoDate(ahora);

  // 1. ANALISTA
  yield s.ev(e("bd", "analista", "consulta", `Lee cartera: ${cliente.nombre}`,
    `${cliente.producto} · cuota S/ ${cliente.monto_cuota} · atraso ${cliente.dias_atraso} d · sueldo ${cliente.sueldo_llego_mes ? "llegó" : "NO llegó"} · uso línea ${cliente.uso_linea_tc_pct}%`));
  const an = analizar(publico(cliente), ctx.modelo);
  await ctx.cartera.actualizarAnalisis(cliente.cliente_id, an);
  await ctx.gestiones.insertar({
    cliente_id: cliente.cliente_id, agente: "analista", accion: "priorizar", canal: null, mensaje: null, resultado: an.prioridad,
    motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false, justificacion: an.justificacion,
  });
  yield s.ev(e("analista", "bd", "registro", `Escribe análisis · prioridad ${an.prioridad}`, `${an.justificacion} Grupo: ${cliente.grupo}.`, "ok", an));

  if (cliente.grupo === "control") {
    await ctx.gestiones.insertar({
      cliente_id: cliente.cliente_id, agente: "analista", accion: "control_sin_contacto", canal: null, mensaje: null, resultado: "control",
      motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false,
      justificacion: "Grupo de control: no se contacta para poder medir el efecto de la estrategia.",
    });
    yield s.ev(e("analista", "bd", "registro", "Grupo de control: sin contacto", "Se deja sin gestión para medir el efecto de la estrategia.", "info"));
    yield { tipo: "fin", estado: "control", detalle: "Cliente en grupo de control: no se contacta." };
    return;
  }

  // 2. PROPUESTA DE CONTACTO ⇄ SUPERVISOR
  const prev = await contactosPrevios(ctx.gestiones, cliente.cliente_id, ahora);
  if (prev >= maxContactosSemana(reglas)) {
    yield s.ev(e("supervisor", "analista", "validacion", "Rechaza: límite de contactos", `Ya hubo ${prev} contacto(s) en 7 días.`, "rechazado"));
    yield { tipo: "fin", estado: "cerrado", detalle: "Límite de contactos por semana alcanzado." };
    return;
  }
  let canal: string = cliente.canal_preferido;
  let slot = { fecha: hoy, hora: "00:00" };
  for (let extra = 0; extra <= 7; extra++) {
    slot = proponerSlot(cliente, ahora, hoy, extra);
    const prop = { canal, ...slot, justificacion: an.justificacion };
    yield s.ev(e("analista", "supervisor", "propuesta", `Propone ${canal} el ${slot.fecha} a las ${slot.hora}`,
      `Canal preferido del cliente y ventana en la que suele responder (${cliente.hora_respuesta} h).`, "info", prop));
    const v = validarPropuesta(prop, reglas, prev);
    if (!v.ok) {
      await ctx.gestiones.insertar({
        cliente_id: cliente.cliente_id, agente: "supervisor", accion: "validar", canal, mensaje: null, resultado: "rechazado",
        motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false, justificacion: v.feedback,
      });
      yield s.ev(e("supervisor", "analista", "validacion", "Rechaza la propuesta", v.feedback + " → el Analista reprograma.", "rechazado", v));
      continue;
    }
    await ctx.gestiones.insertar({
      cliente_id: cliente.cliente_id, agente: "supervisor", accion: "validar", canal, mensaje: null, resultado: "aprobado",
      motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false,
      justificacion: `Dentro del horario (${slot.fecha} ${slot.hora}) y del límite de contactos (${prev}/${maxContactosSemana(reglas)}).`,
    });
    yield s.ev(e("supervisor", "gestor", "validacion", "Aprueba el contacto", `Dentro del horario y del límite de contactos (${prev}/${maxContactosSemana(reglas)} esta semana).`, "ok"));
    break;
  }

  // 3. CONVERSACIÓN GESTOR ⇄ SUPERVISOR ⇄ CLIENTE
  const historial: Turno[] = [];
  const escalar = motivosEscalamiento(reglas);
  for (let t = 0; t < maxTurnos; t++) {
    let turno: GestorTurn | null = null;
    let feedback: string | undefined;
    let aprobado = false;

    for (let intento = 0; intento <= MAX_REINTENTOS; intento++) {
      turno = await ctx.gestor.turno({ cliente: publico(cliente), reglas, historial, hoy, numeroTurno: t + 1, retroalimentacion: feedback });
      if (escalar.includes(turno.motivo_no_pago) && turno.accion !== "escalar_humano") {
        yield s.ev(e("supervisor", "gestor", "validacion", "Regla de escalamiento", `Motivo "${turno.motivo_no_pago}": el Supervisor fuerza el paso a un humano.`, "info"));
        turno = { ...turno, accion: "escalar_humano", regla_id: null };
      }
      yield s.ev(e("gestor", "supervisor", "mensaje", `Gestor propone mensaje (${turno.accion})`, turno.mensaje, "info", turno));
      const v = await validarMensaje({ tono: ctx.tono }, { mensaje: turno.mensaje, turno, cliente: publico(cliente), reglas, hoy });
      if (v.ok) {
        aprobado = true;
        yield s.ev(e("supervisor", "cliente", "validacion", "Mensaje aprobado y enviado", v.avisos.join(" · ") || "Cumple horario, lenguaje, tono y reglas de pago.", "ok"));
        break;
      }
      await ctx.gestiones.insertar({
        cliente_id: cliente.cliente_id, agente: "supervisor", accion: "validar", canal, mensaje: turno.mensaje, resultado: "rechazado",
        motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false, justificacion: v.feedback,
      });
      yield s.ev(e("supervisor", "gestor", "validacion", "Rechaza el mensaje", v.feedback, "rechazado", v));
      feedback = v.feedback;
    }

    if (!turno) break;
    if (!aprobado) {
      yield s.ev(e("gestor", "humano", "escalamiento", "El Gestor no logra un mensaje válido", "Se deriva a una persona.", "info"));
      yield { tipo: "fin", estado: "esperando_humano", detalle: "El supervisor rechazó el mensaje tras varios intentos." };
      return;
    }

    await ctx.gestiones.insertar({
      cliente_id: cliente.cliente_id, agente: "gestor", accion: t === 0 ? "contacto_inicial" : "conversar", canal, mensaje: turno.mensaje,
      resultado: "aprobado", motivo_no_pago: turno.motivo_no_pago === "desconocido" ? null : turno.motivo_no_pago,
      monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: turno.accion === "escalar_humano", justificacion: turno.justificacion,
    });
    historial.push({ rol: "gestor", texto: turno.mensaje });

    if (turno.accion === "escalar_humano") {
      yield s.ev(e("gestor", "humano", "escalamiento", "Escala el caso a un humano", turno.resumen_humano ?? turno.justificacion, "info",
        { resumen: turno.resumen_humano, borrador: turno.borrador_humano, motivo: turno.motivo_no_pago }));
      yield { tipo: "fin", estado: "esperando_humano", detalle: turno.resumen_humano ?? undefined };
      return;
    }
    if (turno.accion === "registrar_promesa") {
      yield* registrarPromesa(ctx, s, cliente, turno, canal);
      yield { tipo: "fin", estado: "promesa_registrada", detalle: `S/ ${turno.monto_promesa} el ${turno.fecha_promesa}` };
      return;
    }
    if (turno.accion === "cerrar") { yield { tipo: "fin", estado: "cerrado" }; return; }

    // preguntar / ofrecer → responde el cliente
    const respuesta = await ctx.cliente.responder({ cliente, historial, ultimoMensaje: turno.mensaje, deHumano: false, hoy });
    historial.push({ rol: "cliente", texto: respuesta });
    await ctx.gestiones.insertar({
      cliente_id: cliente.cliente_id, agente: "cliente", accion: "responder", canal, mensaje: respuesta, resultado: "respondió",
      motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false, justificacion: null,
    });
    yield s.ev(e("cliente", "gestor", "respuesta", "El cliente responde", respuesta));
  }
  yield { tipo: "fin", estado: "sin_respuesta", detalle: "Se alcanzó el máximo de turnos sin una promesa." };
}

async function* registrarPromesa(ctx: Ctx, s: Secuencia, cliente: Cliente, turno: GestorTurn, canal: string): AsyncGenerator<EventoStream> {
  yield s.ev(e("gestor", "supervisor", "registro", `Registra promesa: S/ ${turno.monto_promesa} el ${turno.fecha_promesa}`, turno.justificacion, "info"));
  const g = await ctx.gestiones.insertar({
    cliente_id: cliente.cliente_id, agente: "gestor", accion: "promesa", canal, mensaje: turno.mensaje, resultado: "promesa_registrada",
    motivo_no_pago: turno.motivo_no_pago === "desconocido" ? null : turno.motivo_no_pago, monto_promesa: turno.monto_promesa, fecha_promesa: turno.fecha_promesa,
    estado_promesa: "pendiente", derivado_humano: false, justificacion: turno.justificacion,
  });
  yield s.ev(e("supervisor", "bd", "registro", `Guarda promesa #${g.gestion_id} (pendiente)`, `Motivo de no pago: ${turno.motivo_no_pago}.`, "ok"));
}

/** Turno del humano: escribe (o cierra), el Supervisor valida, el cliente responde y el Gestor extrae el resultado. */
export async function* turnoHumano(ctx: Ctx, clienteId: string, input: { accion: "enviar" | "cerrar"; mensaje?: string }): AsyncGenerator<EventoStream> {
  const s = new Secuencia();
  const cliente = await ctx.cartera.get(clienteId);
  if (!cliente) { yield { tipo: "fin", estado: "error", detalle: `Cliente ${clienteId} no existe` }; return; }
  const reglas = await ctx.reglasRepo.todas();
  const hoy = isoDate(ctx.ahora());
  const canal = cliente.canal_preferido;
  const previas = await ctx.gestiones.porCliente(clienteId);
  const historial = historialDe(previas);

  if (input.accion === "cerrar") {
    await ctx.gestiones.insertar({
      cliente_id: clienteId, agente: "humano", accion: "cerrar", canal, mensaje: null, resultado: "cerrado_por_humano",
      motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: true, justificacion: "El asesor cierra el caso.",
    });
    yield s.ev(e("humano", "bd", "registro", "El asesor cierra el caso", undefined, "ok"));
    yield { tipo: "fin", estado: "cerrado" };
    return;
  }

  const mensaje = (input.mensaje ?? "").trim();
  yield s.ev(e("humano", "supervisor", "mensaje", "El asesor envía un mensaje", mensaje));
  const v = await validarMensaje({ tono: ctx.tono }, { mensaje, cliente: publico(cliente), reglas, hoy, soloLenguaje: true });
  if (!v.ok) {
    yield s.ev(e("supervisor", "humano", "validacion", "Rechaza el mensaje del asesor", v.feedback, "rechazado", v));
    yield { tipo: "fin", estado: "esperando_humano", detalle: `Mensaje rechazado: ${v.feedback}` };
    return;
  }
  yield s.ev(e("supervisor", "cliente", "validacion", "Mensaje del asesor aprobado y enviado", v.avisos.join(" · ") || "Cumple lenguaje y tono.", "ok"));
  await ctx.gestiones.insertar({
    cliente_id: clienteId, agente: "humano", accion: "conversar", canal, mensaje, resultado: "aprobado", motivo_no_pago: null,
    monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: true, justificacion: "Mensaje redactado por un asesor humano.",
  });
  historial.push({ rol: "humano", texto: mensaje });

  const respuesta = await ctx.cliente.responder({ cliente, historial, ultimoMensaje: mensaje, deHumano: true, hoy });
  historial.push({ rol: "cliente", texto: respuesta });
  await ctx.gestiones.insertar({
    cliente_id: clienteId, agente: "cliente", accion: "responder", canal, mensaje: respuesta, resultado: "respondió",
    motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: true, justificacion: null,
  });
  yield s.ev(e("cliente", "gestor", "respuesta", "El cliente responde al asesor", respuesta));

  const turno = await ctx.gestor.turno({ cliente: publico(cliente), reglas, historial, hoy, numeroTurno: historial.length, humanoActivo: true });
  yield s.ev(e("gestor", "supervisor", "mensaje", `El Gestor analiza el resultado (${turno.accion})`, turno.justificacion, "info", turno));

  if (turno.accion === "registrar_promesa" && turno.monto_promesa && turno.fecha_promesa) {
    yield* registrarPromesa(ctx, s, cliente, turno, canal);
    yield { tipo: "fin", estado: "promesa_registrada", detalle: `S/ ${turno.monto_promesa} el ${turno.fecha_promesa}` };
    return;
  }
  if (turno.accion === "cerrar") { yield { tipo: "fin", estado: "cerrado" }; return; }
  yield s.ev(e("gestor", "humano", "escalamiento", "Vuelve al asesor", turno.mensaje || turno.justificacion, "info",
    { resumen: turno.mensaje, borrador: turno.borrador_humano, motivo: turno.motivo_no_pago }));
  yield { tipo: "fin", estado: "esperando_humano", detalle: turno.justificacion };
}
