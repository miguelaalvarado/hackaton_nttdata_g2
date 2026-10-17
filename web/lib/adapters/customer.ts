import type { CustomerSimulator } from "../core/ports";
import type { Client, Proposal } from "../core/types";
import { FAST_MODEL, chatModel } from "./llm";

/** Situación oculta del cliente, determinística por id para que la demo sea reproducible. */
export type Scenario = "olvido" | "sin_liquidez" | "ignora" | "disputa";

export function scenarioOf(client: Client): Scenario {
  const h = [...client.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  if (client.risk_band === "alto") return (["sin_liquidez", "sin_liquidez", "ignora", "disputa"] as const)[h % 4];
  return (["olvido", "olvido", "ignora", "sin_liquidez"] as const)[h % 4];
}

/** Cliente simulado por reglas (sin red). */
export const scriptedCustomer: CustomerSimulator = {
  name: "scripted",
  async reply({ client, proposal }) {
    const s = scenarioOf(client);
    const quiet = proposal.channel === "email" || proposal.channel === "push_sms";
    if (s === "ignora" && quiet) return "(sin respuesta)";
    if (s === "olvido") return proposal.offer === "recordatorio" ? "Uy, se me pasó. Pago hoy mismo, gracias por avisar." : "Ah, me olvidé. De acuerdo, pago hoy.";
    if (s === "disputa") return "No estoy de acuerdo con este cobro, voy a hacer un reclamo. No me llamen más.";
    // sin_liquidez (o ignora por canal personal)
    if (proposal.offer === "plan_de_pagos" || proposal.offer === "refinanciamiento") return "Con cuotas más pequeñas sí podría. Acepto, de acuerdo.";
    if (proposal.offer === "reprogramacion") return "Necesito más tiempo, quizás a fin de mes pueda pagar.";
    return "Este mes no puedo pagar, no me alcanza el dinero.";
  },
};

/** Cliente simulado por LLM, guiado por el escenario oculto y reaccionando a la oferta y el canal reales. */
export function llmCustomer(model = FAST_MODEL): CustomerSimulator {
  const m = chatModel(model, 0.7);
  return {
    name: `llm:${model}`,
    async reply({ client, proposal }) {
      const res = await m.invoke([
        {
          role: "system",
          content:
            `Interpretas a ${client.name}, cliente de un banco con una deuda atrasada. Situación real (no la reveles de entrada): ${scenarioOf(client)}.\n` +
            `- olvido: se te pasó la fecha; pagas si te lo recuerdan.\n- sin_liquidez: no tienes dinero este mes; aceptas solo una cuota/plazo realista, no un simple recordatorio.\n` +
            `- ignora: no respondes por canales impersonales (correo, SMS); sí por llamada o WhatsApp.\n- disputa: crees que el cobro es erróneo y te molesta que insistan.\n` +
            `Ingreso mensual ${client.monthly_income}. Responde en 1-2 frases, en español coloquial peruano. Si no responderías por este canal, escribe exactamente: (sin respuesta)`,
        },
        { role: "user", content: `Canal: ${proposal.channel}. Mensaje del banco: """${proposal.message}"""` },
      ]);
      return String(res.content).trim();
    },
  };
}
