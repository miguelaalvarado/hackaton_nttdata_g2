import { channelLabel, channelOptions } from "../core/channels";
import type { CollectionAgent, RiskScorer } from "../core/ports";
import type { Client, ContactAttempt, Offer, ProposalDraft, TraceStep } from "../core/types";

function pickOffer(client: Client, history: ContactAttempt[]): Offer {
  const last = history.at(-1);
  if (last?.outcome === "no_puede_pagar") return client.debt_ratio > 1 ? "refinanciamiento" : "plan_de_pagos";
  if (last?.outcome === "pide_plazo") return "reprogramacion";
  if (last?.outcome === "rechaza") return "aclaracion_de_cobro";
  if (last?.outcome === "sin_respuesta") return "plan_de_pagos";
  return client.late_30_59 + client.late_60_89 + client.late_90_plus > 0 ? "plan_de_pagos" : "recordatorio";
}

const BODY: Record<Offer, string> = {
  recordatorio: "te recordamos que tienes un pago próximo a vencer. Si ya lo realizaste, ignora este mensaje.",
  reprogramacion: "podemos reprogramar tu fecha de pago sin costo adicional para que se ajuste a tu calendario.",
  plan_de_pagos: "tenemos un plan de pagos en cuotas pequeñas que se adapta a tu presupuesto actual.",
  refinanciamiento: "podemos refinanciar tu deuda a un plazo mayor para reducir tu cuota mensual.",
  aclaracion_de_cobro: "queremos revisar contigo el detalle de este cobro y corregirlo si hay un error.",
};

/** Agente de respaldo sin LLM: elige el canal de mayor valor neto y adapta la oferta al historial. */
export function scriptedAgent(scorer: RiskScorer): CollectionAgent {
  return {
    name: "scripted",
    async propose({ client, history }) {
      const risk = await scorer.assess(client);
      const options = channelOptions(client, risk, history);
      const best = options[0];
      const offer = pickOffer(client, history);
      const trace: TraceStep[] = [
        { kind: "tool_call", name: "get_risk_assessment", args: {} },
        { kind: "tool_result", name: "get_risk_assessment", content: JSON.stringify(risk) },
        { kind: "tool_call", name: "list_channel_options", args: {} },
        { kind: "tool_result", name: "list_channel_options", content: JSON.stringify(options.slice(0, 3)) },
        { kind: "note", content: "Modo sin LLM: reglas determinísticas (configura OPENROUTER_API_KEY para usar el agente real)." },
      ];
      const draft: ProposalDraft = {
        channel: best.channel,
        offer,
        send_hour: 18,
        tone: "cercano",
        message: `Hola ${client.name.split(" ")[0]}, ${BODY[offer]} ¿Te parece si lo coordinamos? Responde a este mensaje y te ayudamos.`,
        rationale:
          `PD ${(risk.pd * 100).toFixed(1)} %. Mejor valor neto: ${channelLabel(best.channel)} ` +
          `(costo ${best.cost}, pérdida evitada ${best.expected_loss_avoided}).` +
          (history.length ? ` Cambio de táctica tras "${history.at(-1)!.outcome}".` : ""),
      };
      return { draft, trace };
    },
  };
}
