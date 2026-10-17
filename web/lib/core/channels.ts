import type { Channel, Client, ChannelOption, ContactAttempt, RiskAssessment } from "./types";
import { CHANNELS } from "./types";

/**
 * Catálogo de canales. TODOS los números son supuestos de la demo (no provienen de datos):
 * costo por contacto en USD y reducción relativa de la pérdida esperada si el contacto funciona.
 * Reemplazar por cifras reales del banco sin tocar el resto del código.
 */
export const LGD = 0.6;

const CATALOG: Record<Channel, { label: string; cost: number; effectiveness: number }> = {
  push_sms: { label: "Push / SMS", cost: 0.05, effectiveness: 0.1 },
  whatsapp: { label: "WhatsApp", cost: 0.12, effectiveness: 0.18 },
  email: { label: "Correo", cost: 0.02, effectiveness: 0.06 },
  llamada_preventiva: { label: "Llamada preventiva (bot)", cost: 1.5, effectiveness: 0.25 },
  llamada_asesor: { label: "Llamada de asesor", cost: 4.5, effectiveness: 0.4 },
  gestion_avanzada: { label: "Gestión de cobranza avanzada", cost: 28, effectiveness: 0.5 },
};

export const channelLabel = (c: Channel) => CATALOG[c].label;

export const expectedLoss = (client: Client, risk: Pick<RiskAssessment, "pd">) => risk.pd * client.exposure_ead * LGD;

/** Un canal ya probado sin éxito pierde efectividad: el agente debe cambiar de táctica. */
const FAILED_PENALTY = 0.35;

export function channelOptions(client: Client, risk: RiskAssessment, history: ContactAttempt[]): ChannelOption[] {
  const loss = expectedLoss(client, risk);
  return CHANNELS.map((channel) => {
    const base = CATALOG[channel];
    const failedBefore = history.some((h) => h.channel === channel && h.outcome !== "pagara");
    const effectiveness = base.effectiveness * (failedBefore ? FAILED_PENALTY : 1);
    const avoided = loss * effectiveness;
    return {
      channel,
      label: base.label,
      cost: base.cost,
      effectiveness: Number(effectiveness.toFixed(3)),
      expected_loss_avoided: Number(avoided.toFixed(2)),
      net_value: Number((avoided - base.cost).toFixed(2)),
      note: failedBefore ? "ya se intentó sin éxito: efectividad reducida" : undefined,
    };
  }).sort((a, b) => b.net_value - a.net_value);
}

export function economics(client: Client, risk: RiskAssessment, history: ContactAttempt[], channel: Channel) {
  const opt = channelOptions(client, risk, history).find((o) => o.channel === channel)!;
  return {
    expected_cost: opt.cost,
    expected_loss: Number(expectedLoss(client, risk).toFixed(2)),
    expected_loss_avoided: opt.expected_loss_avoided,
    net_value: opt.net_value,
  };
}
