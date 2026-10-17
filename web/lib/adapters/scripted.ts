import { borradorSupervisor } from "../core/borrador-supervisor";
import type { ClienteSimulator, GestorAgent } from "../core/ports";
import { evalCondicion, motivosEscalamiento, reglasDe, sumarDias } from "../core/reglas";
import type { GestorResultado, GestorTurn, Motivo } from "../core/types";

const has = (t: string, re: RegExp) => re.test(t.toLowerCase());

function detectarMotivo(t: string): Motivo | null {
  if (has(t, /despid|desemple|sin trabajo|perd[ií] mi trabajo|me quedé sin/)) return "desempleo";
  if (has(t, /no reconozco|no es mi deuda|no la contrat|no debo nada/)) return "desconoce_deuda";
  if (has(t, /reclamo|cobro indebido|no estoy de acuerdo|cargos que no/)) return "reclamo";
  if (has(t, /sueldo|me pagan|abono|me depositan|cobro el/)) return "retraso_ingresos";
  if (has(t, /olvid|se me pas/)) return "olvido";
  if (has(t, /no me alcanza|no tengo dinero|corto de|imprevist|no puedo pagar/)) return "iliquidez";
  return null;
}

const nulos = { regla_id: null, monto_promesa: null, fecha_promesa: null, resumen_humano: null, borrador_humano: null } as const;

/** Gestor por reglas, sin LLM: respaldo de demo y modo lote. Mismas reglas de negocio que el Gestor LLM. */
export const gestorScripted: GestorAgent = {
  name: "reglas (sin LLM)",
  async turno(input): Promise<GestorResultado> {
    return { ...(await turnoReglas(input)), meta: { motor: "reglas" } };
  },
};

async function turnoReglas({ cliente, reglas, historial, hoy, humanoActivo }: Parameters<GestorAgent["turno"]>[0]): Promise<GestorTurn> {
    const ultimoCliente = [...historial].reverse().find((t) => t.rol === "cliente")?.texto ?? "";
    const previoGestor = [...historial].reverse().find((t) => t.rol === "gestor");
    const primer = cliente.nombre.split(" ")[0];

    if (!historial.some((t) => t.rol === "cliente") && !humanoActivo) {
      return {
        ...nulos, accion: "preguntar", motivo_no_pago: "desconocido",
        mensaje: `Hola ${primer}, te escribimos de tu banco por tu ${cliente.producto} (cuota S/ ${cliente.monto_cuota}). ¿Pasó algo que te impidió pagar? Queremos ayudarte.`,
        justificacion: "Primer contacto: se pregunta el motivo antes de ofrecer.",
      };
    }

    const motivo = detectarMotivo(ultimoCliente) ?? (historial.find((t) => t.rol === "cliente") ? detectarMotivo(historial.filter((t) => t.rol === "cliente").map((t) => t.texto).join(" ")) : null) ?? "desconocido";
    const escalar = motivosEscalamiento(reglas);
    const acepta = has(ultimoCliente, /acepto|de acuerdo|\bsí\b|\bsi\b|ok|listo|puedo pagar|pago hoy|prometo|dale|perfecto|me parece/);

    if (escalar.includes(motivo) && !humanoActivo) {
      return {
        ...nulos, accion: "escalar_humano", motivo_no_pago: motivo,
        mensaje: "Entiendo, gracias por contarme. Un asesor se comunicará contigo para ayudarte personalmente.",
        justificacion: `Motivo "${motivo}": la regla de escalamiento exige pasar a un humano.`,
        resumen_humano: `Cliente ${cliente.nombre} (${cliente.producto}, atraso ${cliente.dias_atraso} d). Motivo: ${motivo}. Dijo: "${ultimoCliente}"`,
        borrador_humano: borradorSupervisor(cliente.nombre),
      };
    }

    // Aceptación de una oferta previa -> registrar promesa
    if ((previoGestor && acepta) || (humanoActivo && acepta)) {
      const opcion = reglasDe(reglas, "opcion_pago").find((r) => evalCondicion(r.condicion, { motivo, dias_atraso: cliente.dias_atraso }));
      const fraccion = opcion?.valor.includes("fraccionar");
      const dia = ultimoCliente.match(/(?:el|dia|día)\s+(\d{1,2})\b/i)?.[1];
      let fecha = sumarDias(hoy, opcion?.valor.includes("hoy") ? 0 : 7);
      if (dia && !humanoActivo) {
        const d = +dia; const base = new Date(`${hoy}T12:00:00`);
        for (let k = 0; k <= 7; k++) { const t = new Date(base); t.setDate(base.getDate() + k); if (t.getDate() === d) { fecha = sumarDias(hoy, k); break; } }
      }
      if (humanoActivo) fecha = sumarDias(hoy, 7);
      const monto = fraccion ? Math.round(cliente.monto_cuota / 2) : cliente.monto_cuota;
      return {
        ...nulos, accion: "registrar_promesa", motivo_no_pago: motivo, regla_id: opcion?.regla_id ?? null, monto_promesa: monto, fecha_promesa: fecha,
        mensaje: `Perfecto ${primer}, quedamos en que pagas S/ ${monto} el ${fecha}. ¡Gracias por tu compromiso!`,
        justificacion: `El cliente aceptó${opcion ? ` la regla ${opcion.regla_id} (${opcion.valor})` : ""}; se registra la promesa.`,
      };
    }

    const opcion = reglasDe(reglas, "opcion_pago").find((r) => evalCondicion(r.condicion, { motivo, dias_atraso: cliente.dias_atraso }));
    if (opcion && !humanoActivo) {
      return {
        ...nulos, accion: "ofrecer", motivo_no_pago: motivo, regla_id: opcion.regla_id,
        mensaje: `Gracias por contarme, ${primer}. Podemos ayudarte: ${opcion.valor}. ¿Te sirve? Si aceptas, dime qué día puedes pagar.`,
        justificacion: `Motivo "${motivo}" -> regla ${opcion.regla_id} (${opcion.condicion}).`,
      };
    }
    return {
      ...nulos, accion: "escalar_humano", motivo_no_pago: motivo, mensaje: "Gracias, un asesor te contactará para encontrar una solución.",
      justificacion: "Ninguna opción de la tabla de reglas aplica a este caso.",
      resumen_humano: `Sin opción de reglas aplicable. Motivo: ${motivo}. Última respuesta: "${ultimoCliente}"`,
      borrador_humano: borradorSupervisor(cliente.nombre),
    };
}

/** Cliente simulado por reglas (sin red), según su escenario oculto. */
export const clienteScripted: ClienteSimulator = {
  name: "reglas (sin LLM)",
  async responder({ cliente, historial, ultimoMensaje, deHumano }) {
    const esc = cliente.sim_escenario;
    const m = ultimoMensaje.toLowerCase();
    const preguntaMotivo = !historial.some((t) => t.rol === "cliente");
    if (deHumano) {
      if (/plan|cuota|revis|verific|acord|propuesta|ayud/.test(m)) return "Gracias por escucharme, sí acepto, de acuerdo. Puedo pagar la primera cuota en una semana.";
      return "No sé, tendría que pensarlo.";
    }
    if (preguntaMotivo) {
      return {
        retraso_ingresos: `Es que mi sueldo se atrasó este mes, me pagan el ${cliente.dia_abono_sueldo}.`,
        iliquidez: "La verdad no me alcanza este mes, tuve gastos imprevistos.",
        olvido: "Uy, se me pasó la fecha, disculpa.",
        desempleo: "Me despidieron hace poco y no tengo trabajo, estoy complicado.",
        reclamo: "Tengo un reclamo, hay cargos que no estoy de acuerdo y no pienso pagarlos así.",
        desconoce_deuda: "No reconozco esa deuda, yo no contraté eso.",
      }[esc] ?? "Se me pasó, disculpa.";
    }
    if (/fecha|mover|fraccion|dividir|2 pagos|pagar hoy|app|transferencia/.test(m)) {
      if (esc === "retraso_ingresos") return `Sí, de acuerdo. Me depositan el ${cliente.dia_abono_sueldo}, ahí pago.`;
      if (esc === "iliquidez") return "Sí, acepto pagarlo en 2 partes, de acuerdo.";
      if (esc === "olvido") return "Ok, de acuerdo, pago hoy mismo.";
    }
    return "No, eso no me sirve, gracias.";
  },
};
