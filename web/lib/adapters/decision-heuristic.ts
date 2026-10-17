import type { DecisionEngine } from "../core/ports";

const FORBIDDEN = ["embargo", "denuncia", "policía", "policia", "cárcel", "carcel", "familiares", "vecinos", "última advertencia", "ultima advertencia"];
const has = (text: string, words: string[]) => words.some((w) => text.includes(w));

/**
 * DecisionEngine determinístico y sin red: funciona sin API key (demo de respaldo y tests).
 * Cada decisión se resuelve por `id`; un id desconocido falla de forma explícita.
 */
export const heuristicDecisionEngine: DecisionEngine = {
  name: "heuristic",

  async choose({ id, context, options }) {
    const t = context.toLowerCase();
    if (id === "customer_outcome") {
      const pick = (o: string, confidence: number) => ({ choice: o as (typeof options)[number], confidence });
      if (!t.trim() || has(t, ["(sin respuesta)"])) return pick("sin_respuesta", 0.9);
      if (has(t, ["no puedo pagar", "sin dinero", "no tengo", "desempleo", "sin trabajo", "no me alcanza"])) return pick("no_puede_pagar", 0.85);
      if (has(t, ["no voy a pagar", "no pienso", "no me llamen", "dejen de", "reclamo"])) return pick("rechaza", 0.85);
      if (has(t, ["más tiempo", "mas tiempo", "próxima semana", "proxima semana", "fin de mes", "plazo", "reprogram"])) return pick("pide_plazo", 0.8);
      if (has(t, ["pago hoy", "pagaré", "pagare", "ya pago", "acepto", "de acuerdo", "transfer", "ok"])) return pick("pagara", 0.8);
      return pick("sin_respuesta", 0.5);
    }
    throw new Error(`heuristicDecisionEngine: decisión desconocida "${id}"`);
  },

  async yesNo({ id, context }) {
    if (id === "message_tone_ok") {
      const t = context.toLowerCase();
      if (has(t, FORBIDDEN)) return { probability: 0.05 };
      const urgent = (t.match(/!/g) ?? []).length > 2 || has(t, ["inmediatamente", "ya mismo", "urgente urgente"]);
      return { probability: urgent ? 0.55 : 0.93 };
    }
    throw new Error(`heuristicDecisionEngine: decisión desconocida "${id}"`);
  },

  async score({ id }) {
    throw new Error(`heuristicDecisionEngine: decisión desconocida "${id}"`);
  },
};
