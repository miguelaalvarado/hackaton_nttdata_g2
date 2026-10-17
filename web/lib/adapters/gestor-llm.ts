import type { GestorAgent } from "../core/ports";
import { GestorTurnSchema, type ClientePublico, type Regla, type Turno } from "../core/types";
import { AGENT_MODEL, chatModel } from "./llm";

const SYSTEM = `Eres el GESTOR de cobranza temprana de un banco peruano. Conversas por mensajería con un cliente con riesgo de no pagar,
descubres POR QUÉ no paga y le ofreces SOLO opciones de la tabla de reglas. Eres cercano, breve (estilo WhatsApp, 2-3 frases) y respetuoso.

REGLAS DE CONDUCTA
- Primer turno: saluda por el primer nombre, menciona el producto y la cuota/vencimiento, y pregunta amablemente qué ocurrió. NO ofrezcas nada aún. accion="preguntar".
- Cuando el cliente explique, identifica motivo_no_pago (retraso_ingresos, iliquidez, olvido, desempleo, reclamo, desconoce_deuda, otro). Si aún no lo sabes: "desconocido".
- Si el motivo coincide con una regla "escalamiento": accion="escalar_humano". El mensaje al cliente debe ser empático y avisar que un asesor lo contactará. Rellena resumen_humano y borrador_humano.
- Ofrece (accion="ofrecer") únicamente una regla de tipo "opcion_pago" CUYA CONDICIÓN SE CUMPLA para este cliente (motivo y dias_atraso). Indica su regla_id. NUNCA inventes opciones, descuentos, tasas ni plazos fuera de las reglas.
- Si el cliente ACEPTA una oferta: accion="registrar_promesa" con monto_promesa y fecha_promesa (YYYY-MM-DD, fecha absoluta calculada desde HOY, respetando el máximo de días de la regla). El mensaje confirma el compromiso con monto y fecha. Si la regla es fraccionar la cuota en 2 pagos, el monto prometido es la mitad de la cuota.
- Si el cliente rechaza todo y no hay más opciones permitidas: accion="escalar_humano".
- Si el cliente pide que no lo contacten o la conversación ya terminó: accion="cerrar".
- Mensaje listo para enviar: NUNCA uses marcadores como [Nombre], no inventes teléfonos ni nombres de asesor, firma como "tu banco". Sin amenazas ni presión. Prohibido: embargo, denuncia, policía, cárcel, familiares, vecinos, demanda judicial.
- justificacion: 1-2 frases citando lo que dijo el cliente y la regla aplicada.`;

const regla = (r: Regla) => `  - regla_id=${r.regla_id} | tipo=${r.tipo} | condición: ${r.condicion} | valor: ${r.valor}`;

/** Gestor sobre un LLM (DeepSeek vía OpenRouter + LangChain) con salida estructurada. */
export function gestorLlm(model = AGENT_MODEL): GestorAgent {
  const m = chatModel(model, 0.3).withStructuredOutput(GestorTurnSchema);
  return {
    name: `llm:${model}`,
    async turno({ cliente, reglas, historial, hoy, numeroTurno, retroalimentacion, humanoActivo }) {
      const reglasTxt = reglas.filter((r) => ["opcion_pago", "escalamiento"].includes(r.tipo)).map(regla).join("\n");
      const user = [
        `HOY: ${hoy}`,
        `CLIENTE: ${JSON.stringify(publico(cliente))}`,
        `REGLAS DISPONIBLES:\n${reglasTxt}`,
        `CONVERSACIÓN HASTA AHORA:\n${historial.length ? historial.map(fmt).join("\n") : "(aún no hay mensajes)"}`,
        `TURNO NÚMERO: ${numeroTurno}`,
        humanoActivo
          ? "MODO HUMANO ACTIVO: un asesor humano ya escribió al cliente y el cliente respondió. NO redactes un mensaje nuevo para el cliente: analiza la última respuesta y devuelve motivo_no_pago y accion (registrar_promesa si el cliente se comprometió a pagar con monto y fecha; escalar_humano si sigue molesto o necesita más gestión; cerrar si terminó). En 'mensaje' pon un resumen breve de lo ocurrido."
          : "",
        retroalimentacion ? `EL SUPERVISOR RECHAZÓ TU MENSAJE ANTERIOR. Corrígelo: ${retroalimentacion}` : "",
      ].filter(Boolean).join("\n\n");
      return await m.invoke([{ role: "system", content: SYSTEM }, { role: "user", content: user }]);
    },
  };
}

const fmt = (t: Turno) => `${t.rol === "gestor" ? "GESTOR" : t.rol === "humano" ? "ASESOR HUMANO" : "CLIENTE"}: ${t.texto}`;

function publico(c: ClientePublico) {
  return {
    nombre: c.nombre, producto: c.producto, saldo_deuda: c.saldo_deuda, monto_cuota: c.monto_cuota, fecha_vencimiento: c.fecha_vencimiento,
    dias_atraso: c.dias_atraso, dia_abono_sueldo: c.dia_abono_sueldo, sueldo_llego_mes: c.sueldo_llego_mes, canal: c.canal_preferido,
    causa_probable_analista: c.causa_probable, prob_no_pago: c.prob_no_pago,
  };
}
