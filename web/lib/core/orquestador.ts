import { analizar, proponerSlot } from "./analista";
import { estadoCaso, TXT_BLOQUEO } from "./estado";
import { aplicarForzado, guardrailSolicitud } from "./negociacion";
import type { CarteraRepository, ClienteSimulator, GestionRepository, GestorAgent, PagoRepository, ReglaRepository, RiskModel, ToneChecker } from "./ports";
import { isoDate, maxContactosSemana, maxIntentosSinRespuesta, motivosBloqueo, motivosEscalamiento, siguienteSlotPermitido } from "./reglas";
import { contactosPrevios, validarAcuerdo, validarMensaje, validarPropuesta } from "./supervisor";
import type { ActorId, Cliente, ClientePublico, EventoAgente, EventoStream, Gestion, GestorResultado, NuevaGestion, Turno } from "./types";

export type Ctx = {
  cartera: CarteraRepository;
  gestiones: GestionRepository;
  reglasRepo: ReglaRepository;
  pagos: PagoRepository;
  modelo: RiskModel;
  gestor: GestorAgent;
  cliente: ClienteSimulator;
  tono: ToneChecker;
  ahora: () => Date;
  /** Modo que pidió el usuario y modo realmente disponible: si pidió LLM y no hay credenciales se ejecutan reglas y se avisa. */
  modoSolicitado?: "llm" | "scripted";
  degradado?: string;
};

/**
 * planificar: Analista propone → Supervisor valida → queda PROGRAMADO (no se contacta a nadie).
 * ejecutar:   simula la llegada de la fecha y ejecuta el contacto (Gestor ⇄ Cliente).
 * todo:       ambas seguidas (modo lote / API clásica).
 */
export type OpcionesCiclo = {
  fase?: "planificar" | "ejecutar" | "todo";
  /** El cliente simulado NO responde (caso sin respuesta). */
  silencio?: boolean;
  /** Respuestas escritas a mano en la demo (se usan en orden en lugar del cliente simulado). */
  respuestasCliente?: string[];
  maxTurnos?: number;
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

const VACIA: Omit<NuevaGestion, "cliente_id" | "agente" | "accion"> = {
  canal: null, mensaje: null, resultado: null, motivo_no_pago: null, monto_promesa: null, fecha_promesa: null,
  estado_promesa: null, derivado_humano: false, justificacion: null,
};
const reg = (ctx: Ctx, cliente_id: string, agente: ActorId, accion: string, extra: Partial<NuevaGestion>) =>
  ctx.gestiones.insertar({ ...VACIA, cliente_id, agente, accion, ...extra });

const origenDe = (g: Pick<GestorResultado, "meta">) => (g.meta?.motor === "llm" ? "gestor_llm" : g.meta?.motor === "fallback" ? "gestor_fallback" : "gestor_reglas");
const motorDe = (g: Pick<GestorResultado, "meta">) => g.meta?.motor ?? "reglas";

export const historialDe = (gs: Gestion[]): Turno[] =>
  gs.flatMap((g): Turno[] => {
    if (!g.mensaje) return [];
    if (g.agente === "gestor" && ["contacto_inicial", "conversar"].includes(g.accion)) return [{ rol: "gestor", texto: g.mensaje }];
    if (g.agente === "humano" && g.accion === "conversar") return [{ rol: "humano", texto: g.mensaje }];
    if (g.agente === "cliente" && g.accion === "responder") return [{ rol: "cliente", texto: g.mensaje }];
    return [];
  });

const ultimoCliente = (h: Turno[]) => [...h].reverse().find((t) => t.rol === "cliente")?.texto ?? "";

/** Efectos persistentes de lo que el cliente pidió (se derivan del motivo, venga de un LLM o de reglas). */
async function efectos(ctx: Ctx, clienteId: string, turno: GestorResultado, canal: string) {
  if (turno.motivo_no_pago === "pago_declarado")
    await reg(ctx, clienteId, "supervisor", "pago_declarado", { canal, resultado: "pendiente_conciliacion", aprobacion: "pendiente_humano", origen: "cliente_simulado",
      justificacion: "El cliente dice que ya pagó. NO se registra como pago: requiere conciliación o verificación de un asesor." });
  if (turno.motivo_no_pago === "no_contactar")
    await reg(ctx, clienteId, "supervisor", "opt_out", { canal, resultado: "no_contactar", aprobacion: "no_aplica", origen: "cliente_simulado",
      justificacion: "El cliente pidió no ser contactado: se cierra la gestión y no se vuelve a programar contacto." });
}

/** Planificación + ejecución del contacto. Ver `OpcionesCiclo`. */
export async function* ciclo(ctx: Ctx, clienteId: string, opts: OpcionesCiclo = {}): AsyncGenerator<EventoStream> {
  const fase = opts.fase ?? "todo";
  const maxTurnos = opts.maxTurnos ?? 4;
  const s = new Secuencia();
  const cliente = await ctx.cartera.get(clienteId);
  if (!cliente) { yield { tipo: "fin", estado: "error", detalle: `Cliente ${clienteId} no existe` }; return; }
  const reglas = await ctx.reglasRepo.todas();
  const ahora = ctx.ahora();
  const hoy0 = isoDate(ahora);
  const estado0 = estadoCaso(await ctx.gestiones.porCliente(clienteId), motivosBloqueo(reglas));

  if (estado0.bloqueo) {
    yield s.ev(e("supervisor", "analista", "validacion", "Caso suspendido", TXT_BLOQUEO[estado0.bloqueo], "rechazado"));
    yield { tipo: "fin", estado: "bloqueado", detalle: TXT_BLOQUEO[estado0.bloqueo] };
    return;
  }
  if (estado0.esperandoHumano) {
    yield s.ev(e("supervisor", "humano", "escalamiento", "El caso espera a un asesor", "No se contacta de nuevo hasta que una persona actúe."));
    yield { tipo: "fin", estado: "esperando_humano", detalle: "El caso ya fue derivado a un asesor." };
    return;
  }

  let canal: string = cliente.canal_preferido;
  let hoy = hoy0;

  // ---------------------------------------------------------------- PLANIFICAR
  if (fase !== "ejecutar") {
    if (estado0.contacto === "programado") {
      yield s.ev(e("supervisor", "bd", "registro", "Ya hay un contacto programado", `Para ${estado0.programadoPara}. No se duplica.`));
      if (fase === "planificar") { yield { tipo: "fin", estado: "contacto_programado", detalle: `Contacto ya programado para ${estado0.programadoPara}` }; return; }
    } else {
      // 1. ANALISTA
      yield s.ev(e("bd", "analista", "consulta", `Lee cartera: ${cliente.nombre}`,
        `${cliente.producto} · cuota S/ ${cliente.monto_cuota} · atraso ${cliente.dias_atraso} d · sueldo ${cliente.sueldo_llego_mes ? "llegó" : "NO llegó"} · uso línea ${cliente.uso_linea_tc_pct}%`));
      const an = analizar(publico(cliente), ctx.modelo);
      await ctx.cartera.actualizarAnalisis(cliente.cliente_id, an);
      await reg(ctx, clienteId, "analista", "priorizar", { resultado: an.prioridad, justificacion: an.justificacion, origen: "analista", motor: "reglas", aprobacion: "no_aplica" });
      yield s.ev(e("analista", "bd", "registro", `Escribe análisis · prioridad ${an.prioridad}`, `${an.justificacion} Grupo: ${cliente.grupo}.`, "ok", an));

      if (cliente.grupo === "control") {
        await reg(ctx, clienteId, "analista", "control_sin_contacto", { resultado: "control", origen: "analista", aprobacion: "no_aplica",
          justificacion: "Grupo de control: no se contacta para poder medir el efecto de la estrategia." });
        yield s.ev(e("analista", "bd", "registro", "Grupo de control: sin contacto", "Se deja sin gestión para medir el efecto de la estrategia.", "info"));
        yield { tipo: "fin", estado: "control", detalle: "Cliente en grupo de control: no se contacta." };
        return;
      }

      // 2. PROPUESTA DE CONTACTO ⇄ SUPERVISOR  (propuesto → validado → programado)
      const prev = await contactosPrevios(ctx.gestiones, cliente.cliente_id, ahora);
      if (prev >= maxContactosSemana(reglas)) {
        yield s.ev(e("supervisor", "analista", "validacion", "Rechaza: límite de contactos", `Ya hubo ${prev} contacto(s) en 7 días.`, "rechazado"));
        yield { tipo: "fin", estado: "cerrado", detalle: "Límite de contactos por semana alcanzado." };
        return;
      }
      let slot = { fecha: hoy0, hora: "00:00" };
      let validado = false;
      for (let extra = 0; extra <= 7; extra++) {
        slot = proponerSlot(cliente, ahora, hoy0, extra);
        const prop = { canal, ...slot, justificacion: an.justificacion };
        yield s.ev(e("analista", "supervisor", "propuesta", `Propone ${canal} el ${slot.fecha} a las ${slot.hora}`,
          `Canal preferido del cliente y ventana en la que suele responder (${cliente.hora_respuesta} h).`, "info", prop));
        const v = validarPropuesta(prop, reglas, prev);
        if (!v.ok) {
          await reg(ctx, clienteId, "supervisor", "validar", { canal, resultado: "rechazado", justificacion: v.feedback, origen: "analista", aprobacion: "rechazada_supervisor", motor: "reglas" });
          yield s.ev(e("supervisor", "analista", "validacion", "Rechaza la propuesta", v.feedback + " → el Analista reprograma.", "rechazado", v));
          continue;
        }
        await reg(ctx, clienteId, "supervisor", "validar", { canal, resultado: "aprobado", origen: "analista", aprobacion: "validada_supervisor", motor: "reglas",
          justificacion: `Dentro del horario (${slot.fecha} ${slot.hora}) y del límite de contactos (${prev}/${maxContactosSemana(reglas)}).` });
        yield s.ev(e("supervisor", "gestor", "validacion", "Valida el contacto", `Dentro del horario y del límite de contactos (${prev}/${maxContactosSemana(reglas)} esta semana).`, "ok"));
        validado = true;
        break;
      }
      if (!validado) {
        yield s.ev(e("supervisor", "humano", "escalamiento", "No hay horario permitido", "Ningún horario de los próximos 8 días cumple las reglas.", "rechazado"));
        yield { tipo: "fin", estado: "cerrado", detalle: "No se encontró un horario permitido." };
        return;
      }
      const prog = `${slot.fecha}T${slot.hora}`;
      await reg(ctx, clienteId, "supervisor", "programar_contacto", { canal, resultado: "programado", programado_para: prog, origen: "analista", aprobacion: "validada_supervisor", motor: "reglas",
        justificacion: `Contacto por ${canal} programado para ${slot.fecha} ${slot.hora}. Aún NO se ha contactado a nadie.` });
      yield s.ev(e("supervisor", "bd", "registro", `Programa el contacto: ${canal} · ${slot.fecha} ${slot.hora}`, "Estado: programado. Nada se envía hasta que llegue la fecha.", "ok"));
      if (fase === "planificar") { yield { tipo: "fin", estado: "contacto_programado", detalle: `${canal} el ${slot.fecha} a las ${slot.hora}` }; return; }
    }
  }

  // ---------------------------------------------------------------- EJECUTAR
  const gsAhora = await ctx.gestiones.porCliente(clienteId);
  const est = estadoCaso(gsAhora, motivosBloqueo(reglas));
  const programada = [...gsAhora].reverse().find((g) => g.accion === "programar_contacto");
  if (est.contacto !== "programado" || !programada?.programado_para) {
    yield s.ev(e("supervisor", "bd", "validacion", "No hay contacto programado", "Primero hay que analizar y programar el contacto.", "rechazado"));
    yield { tipo: "fin", estado: "error", detalle: "No hay un contacto programado para ejecutar." };
    return;
  }
  const [fProg, hProg] = programada.programado_para.split("T");
  canal = programada.canal ?? canal;
  hoy = fProg > hoy0 ? fProg : hoy0;
  yield s.ev(e("supervisor", "bd", "seguimiento", `SIMULACIÓN: llega la fecha programada (${fProg} ${hProg})`, "Se revalidan las reglas antes de contactar.", "info"));
  const prevAhora = await contactosPrevios(ctx.gestiones, clienteId, ahora);
  const rv = validarPropuesta({ canal, fecha: fProg, hora: hProg, justificacion: "revalidación" }, reglas, prevAhora);
  if (!rv.ok) {
    await reg(ctx, clienteId, "supervisor", "validar", { canal, resultado: "rechazado", justificacion: rv.feedback, origen: "supervisor", aprobacion: "rechazada_supervisor", motor: "reglas" });
    yield s.ev(e("supervisor", "analista", "validacion", "Rechaza el contacto al revalidar", rv.feedback, "rechazado", rv));
    yield { tipo: "fin", estado: "cerrado", detalle: rv.feedback };
    return;
  }

  // 3. CONVERSACIÓN GESTOR ⇄ SUPERVISOR ⇄ CLIENTE
  const historial: Turno[] = [];
  const escalar = motivosEscalamiento(reglas);
  const manuales = [...(opts.respuestasCliente ?? [])];
  for (let t = 0; t < maxTurnos; t++) {
    let turno: GestorResultado | null = null;
    let feedback: string | undefined;
    let aprobado = false;

    for (let intento = 0; intento <= MAX_REINTENTOS; intento++) {
      turno = await ctx.gestor.turno({ cliente: publico(cliente), reglas, historial, hoy, numeroTurno: t + 1, retroalimentacion: feedback });
      const dicho = ultimoCliente(historial);
      const forzado = dicho ? guardrailSolicitud(dicho, publico(cliente), reglas) : null;
      if (forzado) {
        turno = aplicarForzado(turno, forzado);
        yield s.ev(e("supervisor", "gestor", "validacion", "Guardrail: lo pedido no está autorizado", `${forzado.razon} El Supervisor reemplaza la respuesta por una determinística.`, "info"));
      } else if (escalar.includes(turno.motivo_no_pago) && turno.accion !== "escalar_humano") {
        yield s.ev(e("supervisor", "gestor", "validacion", "Regla de escalamiento", `Motivo "${turno.motivo_no_pago}": el Supervisor fuerza el paso a un humano.`, "info"));
        turno = { ...turno, accion: "escalar_humano", regla_id: null };
      }
      yield s.ev(e("gestor", "supervisor", "mensaje", `Gestor propone mensaje (${turno.accion})`, turno.mensaje, "info", turno));
      const v = await validarMensaje({ tono: ctx.tono }, { mensaje: turno.mensaje, turno, cliente: publico(cliente), reglas, hoy });
      if (v.ok) {
        aprobado = true;
        yield s.ev(e("supervisor", "cliente", "validacion", "Mensaje aprobado · ENVÍO SIMULADO", v.avisos.join(" · ") || "Cumple horario, lenguaje, tono y reglas de pago. No se envió nada real.", "ok"));
        break;
      }
      await reg(ctx, clienteId, "supervisor", "validar", { canal, mensaje: turno.mensaje, resultado: "rechazado", justificacion: v.feedback, origen: origenDe(turno), aprobacion: "rechazada_supervisor", motor: motorDe(turno) });
      yield s.ev(e("supervisor", "gestor", "validacion", "Rechaza el mensaje", v.feedback, "rechazado", v));
      feedback = v.feedback;
    }

    if (!turno) break;
    if (!aprobado) {
      await reg(ctx, clienteId, "supervisor", "escalar", { canal, resultado: "derivado_por_rechazos", derivado_humano: true, origen: "supervisor", aprobacion: "pendiente_humano", motor: "reglas",
        justificacion: "El supervisor rechazó el mensaje del Gestor tras varios intentos." });
      yield s.ev(e("gestor", "humano", "escalamiento", "El Gestor no logra un mensaje válido", "Se deriva a una persona.", "info"));
      yield { tipo: "fin", estado: "esperando_humano", detalle: "El supervisor rechazó el mensaje tras varios intentos." };
      return;
    }

    await reg(ctx, clienteId, "gestor", t === 0 ? "contacto_inicial" : "conversar", {
      canal, mensaje: turno.mensaje, resultado: "aprobado", motivo_no_pago: turno.motivo_no_pago === "desconocido" ? null : turno.motivo_no_pago,
      derivado_humano: turno.accion === "escalar_humano", justificacion: turno.justificacion,
      origen: origenDe(turno), aprobacion: turno.accion === "escalar_humano" ? "pendiente_humano" : "validada_supervisor", motor: motorDe(turno),
    });
    historial.push({ rol: "gestor", texto: turno.mensaje });
    await efectos(ctx, clienteId, turno, canal);

    if (turno.accion === "escalar_humano") {
      yield s.ev(e("gestor", "humano", "escalamiento", "Escala el caso a un humano", turno.resumen_humano ?? turno.justificacion, "info",
        { resumen: turno.resumen_humano, borrador: turno.borrador_humano, motivo: turno.motivo_no_pago }));
      yield { tipo: "fin", estado: "esperando_humano", detalle: turno.resumen_humano ?? undefined };
      return;
    }
    if (turno.accion === "registrar_promesa") {
      yield* registrarPromesa(ctx, s, cliente, turno, canal, origenDe(turno));
      yield { tipo: "fin", estado: "promesa_registrada", detalle: `S/ ${turno.monto_promesa} el ${turno.fecha_promesa}` };
      return;
    }
    if (turno.accion === "cerrar") { yield { tipo: "fin", estado: "cerrado", detalle: turno.motivo_no_pago === "no_contactar" ? "El cliente pidió no ser contactado." : undefined }; return; }

    // preguntar / ofrecer → responde el cliente (o no responde)
    const manual = manuales.shift();
    const respuesta = manual ?? (opts.silencio ? null : await ctx.cliente.responder({ cliente, historial, ultimoMensaje: turno.mensaje, deHumano: false, hoy }));
    if (respuesta === null) {
      yield* sinRespuesta(ctx, s, cliente, reglas, ahora, canal);
      return;
    }
    historial.push({ rol: "cliente", texto: respuesta });
    await reg(ctx, clienteId, "cliente", "responder", { canal, mensaje: respuesta, resultado: "respondió", motor: "simulacion", origen: manual ? "cliente_manual_demo" : "cliente_simulado", aprobacion: "no_aplica" });
    yield s.ev(e("cliente", "gestor", "respuesta", manual ? "El cliente responde (texto escrito en la demo)" : "El cliente responde (SIMULADO)", respuesta));
  }
  yield { tipo: "fin", estado: "sin_respuesta", detalle: "Se alcanzó el máximo de turnos sin una promesa." };
}

/** El cliente no contestó: se registra el silencio y se decide una acción PERMITIDA (reintento o derivación); no se insiste sin límite. */
async function* sinRespuesta(ctx: Ctx, s: Secuencia, cliente: Cliente, reglas: Parameters<typeof maxContactosSemana>[0], ahora: Date, canal: string): AsyncGenerator<EventoStream> {
  await reg(ctx, cliente.cliente_id, "cliente", "sin_respuesta", { canal, resultado: "sin_respuesta", motor: "simulacion", origen: "cliente_simulado", aprobacion: "no_aplica",
    justificacion: "El cliente no respondió al contacto." });
  yield s.ev(e("cliente", "gestor", "respuesta", "El cliente NO responde", "Se registra el silencio como resultado del contacto.", "rechazado"));
  const est = estadoCaso(await ctx.gestiones.porCliente(cliente.cliente_id), motivosBloqueo(reglas));
  const maxInt = maxIntentosSinRespuesta(reglas);
  const prev = await contactosPrevios(ctx.gestiones, cliente.cliente_id, ahora);
  const maxSem = maxContactosSemana(reglas);
  if (est.intentosSinRespuesta >= maxInt || prev >= maxSem) {
    const razon = est.intentosSinRespuesta >= maxInt ? `${est.intentosSinRespuesta} intentos sin respuesta (máx. ${maxInt})` : `límite semanal de contactos alcanzado (${prev}/${maxSem})`;
    await reg(ctx, cliente.cliente_id, "supervisor", "escalar", { canal, resultado: "derivado_por_silencio", derivado_humano: true, origen: "supervisor", aprobacion: "pendiente_humano", motor: "reglas",
      justificacion: `No se insiste más: ${razon}. Se deriva a una persona.` });
    yield s.ev(e("supervisor", "humano", "escalamiento", "Deriva a una persona por falta de respuesta", `No se insiste más: ${razon}.`, "info",
      { resumen: `${cliente.nombre} no respondió a ${est.intentosSinRespuesta} contacto(s) por ${canal}. Deuda S/ ${cliente.saldo_deuda}, atraso ${cliente.dias_atraso} d.`, borrador: `Hola ${cliente.nombre.split(" ")[0]}, soy asesor de tu banco. Intentamos escribirte sin éxito y quiero ayudarte con tu cuota. ¿Podemos hablar?`, motivo: "sin_respuesta" }));
    yield { tipo: "fin", estado: "esperando_humano", detalle: `Sin respuesta: ${razon}.` };
    return;
  }
  const sig = proponerSlot(cliente, ahora, isoDate(ahora), 1);
  const slot = siguienteSlotPermitido(reglas, sig.fecha, sig.hora);
  await reg(ctx, cliente.cliente_id, "supervisor", "programar_contacto", { canal, resultado: "reintento", programado_para: `${slot.fecha}T${slot.hora}`, origen: "supervisor", aprobacion: "validada_supervisor", motor: "reglas",
    justificacion: `Sin respuesta (${est.intentosSinRespuesta}/${maxInt}): un reintento permitido el ${slot.fecha} ${slot.hora}. Después se deriva a una persona.` });
  yield s.ev(e("supervisor", "bd", "registro", `Programa un reintento: ${slot.fecha} ${slot.hora}`, `Intento ${est.intentosSinRespuesta} de ${maxInt}; respeta horario y límite semanal.`, "ok"));
  yield { tipo: "fin", estado: "reintento_programado", detalle: `Reintento el ${slot.fecha} a las ${slot.hora}` };
}

async function* registrarPromesa(ctx: Ctx, s: Secuencia, cliente: Cliente, turno: GestorResultado, canal: string, origen: string): AsyncGenerator<EventoStream> {
  yield s.ev(e("gestor", "supervisor", "registro", `Registra promesa: S/ ${turno.monto_promesa} el ${turno.fecha_promesa}`, turno.justificacion, "info"));
  const g = await reg(ctx, cliente.cliente_id, "gestor", "promesa", {
    canal, mensaje: turno.mensaje, resultado: "promesa_registrada", motivo_no_pago: turno.motivo_no_pago === "desconocido" ? null : turno.motivo_no_pago,
    monto_promesa: turno.monto_promesa, fecha_promesa: turno.fecha_promesa, estado_promesa: "pendiente", justificacion: turno.justificacion,
    origen, aprobacion: "validada_supervisor", motor: motorDe(turno), derivado_humano: origen === "asesor_humano",
  });
  yield s.ev(e("supervisor", "bd", "registro", `Guarda promesa #${g.gestion_id} (pendiente)`, `Es una PROMESA, no un pago: el saldo no cambia. Motivo: ${turno.motivo_no_pago}.`, "ok"));
}

export type AccionHumana = { accion: "enviar" | "cerrar" | "levantar_bloqueo"; mensaje?: string; nota?: string };

/** Turno del humano: escribe (o cierra), el Supervisor valida, el cliente responde y el Gestor extrae el resultado. Todo acuerdo se revalida. */
export async function* turnoHumano(ctx: Ctx, clienteId: string, input: AccionHumana, opts: { respuestasCliente?: string[]; silencio?: boolean } = {}): AsyncGenerator<EventoStream> {
  const s = new Secuencia();
  const cliente = await ctx.cartera.get(clienteId);
  if (!cliente) { yield { tipo: "fin", estado: "error", detalle: `Cliente ${clienteId} no existe` }; return; }
  const reglas = await ctx.reglasRepo.todas();
  const hoy = isoDate(ctx.ahora());
  const previas = await ctx.gestiones.porCliente(clienteId);
  const est = estadoCaso(previas, motivosBloqueo(reglas));
  const canal = cliente.canal_preferido;
  const historial = historialDe(previas);

  // Un asesor solo puede actuar sobre casos que le fueron derivados (o para levantar un bloqueo).
  if (input.accion === "levantar_bloqueo") {
    const nota = (input.nota ?? "").trim();
    if (!est.bloqueo || est.bloqueo === "no_contactar") {
      yield { tipo: "fin", estado: "error", detalle: est.bloqueo === "no_contactar" ? "La solicitud de no contacto no se puede levantar." : "El caso no tiene un bloqueo activo." };
      return;
    }
    if (nota.length < 10) { yield { tipo: "fin", estado: "esperando_humano", detalle: "Escribe una nota (mín. 10 caracteres) con el resultado de la verificación." }; return; }
    const accion = est.bloqueo === "disputa" ? "disputa_resuelta" : "pago_verificado";
    await reg(ctx, clienteId, "humano", accion, { canal, resultado: accion, derivado_humano: true, justificacion: nota, origen: "asesor_humano", aprobacion: "no_aplica", motor: "humano" });
    yield s.ev(e("humano", "bd", "registro", est.bloqueo === "disputa" ? "El asesor registra la disputa como resuelta" : "El asesor registra que NO encontró el pago", nota, "ok"));
    yield { tipo: "fin", estado: "esperando_humano", detalle: "Bloqueo levantado: ya se puede negociar." };
    return;
  }
  if (!est.esperandoHumano) {
    yield { tipo: "fin", estado: "error", detalle: "Este caso no está derivado a un asesor." };
    return;
  }

  if (input.accion === "cerrar") {
    await reg(ctx, clienteId, "humano", "cerrar", { canal, resultado: "cerrado_por_humano", derivado_humano: true, justificacion: "El asesor cierra el caso.", origen: "asesor_humano", aprobacion: "no_aplica", motor: "humano" });
    yield s.ev(e("humano", "bd", "registro", "El asesor cierra el caso", undefined, "ok"));
    yield { tipo: "fin", estado: "cerrado" };
    return;
  }
  if (est.bloqueo === "no_contactar") {
    yield { tipo: "fin", estado: "error", detalle: TXT_BLOQUEO.no_contactar };
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
  yield s.ev(e("supervisor", "cliente", "validacion", "Mensaje del asesor aprobado · ENVÍO SIMULADO", v.avisos.join(" · ") || "Cumple lenguaje y tono. No se envió nada real.", "ok"));
  await reg(ctx, clienteId, "humano", "conversar", { canal, mensaje, resultado: "aprobado", derivado_humano: true, justificacion: "Mensaje redactado por un asesor humano.", origen: "asesor_humano", aprobacion: "validada_supervisor", motor: "humano" });
  historial.push({ rol: "humano", texto: mensaje });

  const manual = opts.respuestasCliente?.[0];
  const respuesta = manual ?? (opts.silencio ? null : await ctx.cliente.responder({ cliente, historial, ultimoMensaje: mensaje, deHumano: true, hoy }));
  if (respuesta === null) {
    await reg(ctx, clienteId, "cliente", "sin_respuesta", { canal, resultado: "sin_respuesta", derivado_humano: true, motor: "simulacion", origen: "cliente_simulado", aprobacion: "no_aplica", justificacion: "El cliente no respondió al asesor." });
    await reg(ctx, clienteId, "supervisor", "escalar", { canal, resultado: "vuelve_al_asesor", derivado_humano: true, origen: "supervisor", aprobacion: "pendiente_humano", motor: "reglas", justificacion: "Sin respuesta al asesor: el caso sigue con la persona." });
    yield s.ev(e("cliente", "humano", "respuesta", "El cliente NO responde al asesor", "El caso sigue con la persona; no se insiste automáticamente.", "rechazado"));
    yield { tipo: "fin", estado: "esperando_humano", detalle: "El cliente no respondió al asesor." };
    return;
  }
  historial.push({ rol: "cliente", texto: respuesta });
  await reg(ctx, clienteId, "cliente", "responder", { canal, mensaje: respuesta, resultado: "respondió", derivado_humano: true, motor: "simulacion", origen: manual ? "cliente_manual_demo" : "cliente_simulado", aprobacion: "no_aplica" });
  yield s.ev(e("cliente", "gestor", "respuesta", manual ? "El cliente responde al asesor (texto escrito en la demo)" : "El cliente responde al asesor (SIMULADO)", respuesta));

  let turno = await ctx.gestor.turno({ cliente: publico(cliente), reglas, historial, hoy, numeroTurno: historial.length, humanoActivo: true });
  const forzado = guardrailSolicitud(respuesta, publico(cliente), reglas);
  if (forzado) {
    turno = aplicarForzado(turno, forzado);
    yield s.ev(e("supervisor", "gestor", "validacion", "Guardrail: lo pedido no está autorizado", forzado.razon, "info"));
    await efectos(ctx, clienteId, turno, canal);
  }
  yield s.ev(e("gestor", "supervisor", "mensaje", `El Gestor analiza el resultado (${turno.accion})`, turno.justificacion, "info", turno));

  if (turno.accion === "registrar_promesa") {
    // P0-B: la promesa posterior a un asesor pasa por las MISMAS validaciones determinísticas que cualquier acuerdo.
    const rechazos = validarAcuerdo(turno, publico(cliente), reglas, hoy, est.bloqueo);
    if (rechazos.length) {
      await reg(ctx, clienteId, "supervisor", "validar", { canal, resultado: "rechazado", monto_promesa: turno.monto_promesa, fecha_promesa: turno.fecha_promesa, derivado_humano: true,
        justificacion: `Acuerdo rechazado: ${rechazos.join(" | ")}`, origen: "asesor_humano", aprobacion: "rechazada_supervisor", motor: motorDe(turno) });
      yield s.ev(e("supervisor", "humano", "validacion", "Rechaza el acuerdo: no cumple las reglas", rechazos.join(" | "), "rechazado", { rechazos }));
      await reg(ctx, clienteId, "supervisor", "escalar", { canal, resultado: "vuelve_al_asesor", derivado_humano: true, origen: "supervisor", aprobacion: "pendiente_humano", motor: "reglas",
        justificacion: "El acuerdo no se pudo registrar; el caso sigue con el asesor." });
      yield { tipo: "fin", estado: "esperando_humano", detalle: `Acuerdo no registrado: ${rechazos.join(" | ")}` };
      return;
    }
    yield* registrarPromesa(ctx, s, cliente, turno, canal, "asesor_humano");
    yield { tipo: "fin", estado: "promesa_registrada", detalle: `S/ ${turno.monto_promesa} el ${turno.fecha_promesa}` };
    return;
  }
  if (turno.accion === "cerrar") {
    await reg(ctx, clienteId, "gestor", "cerrar", { canal, resultado: "cerrado", derivado_humano: true, justificacion: turno.justificacion, origen: origenDe(turno), aprobacion: "no_aplica", motor: motorDe(turno) });
    yield { tipo: "fin", estado: "cerrado" };
    return;
  }
  await reg(ctx, clienteId, "gestor", "escalar", { canal, resultado: "vuelve_al_asesor", derivado_humano: true, justificacion: turno.justificacion, motivo_no_pago: turno.motivo_no_pago === "desconocido" ? null : turno.motivo_no_pago,
    origen: origenDe(turno), aprobacion: "pendiente_humano", motor: motorDe(turno) });
  yield s.ev(e("gestor", "humano", "escalamiento", "Vuelve al asesor", turno.mensaje || turno.justificacion, "info",
    { resumen: turno.resumen_humano ?? turno.mensaje, borrador: turno.borrador_humano, motivo: turno.motivo_no_pago }));
  yield { tipo: "fin", estado: "esperando_humano", detalle: turno.justificacion };
}

