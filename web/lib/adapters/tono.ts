import { z } from "zod";
import type { ToneChecker } from "../core/ports";
import { FAST_MODEL, chatModel } from "./llm";

const PROHIBIDAS = ["embargo", "denuncia", "policía", "cárcel", "familiares", "vecinos", "última advertencia"];

/** Revisión de tono sin red (reglas). */
export const tonoHeuristico: ToneChecker = {
  name: "heurístico",
  async respetuoso(mensaje) {
    const t = mensaje.toLowerCase();
    if (PROHIBIDAS.some((w) => t.includes(w))) return 0.05;
    const gritos = (mensaje.match(/!/g) ?? []).length > 2 || /inmediatamente|ya mismo/.test(t);
    return gritos ? 0.55 : 0.93;
  },
};

/** Revisión de tono con LLM; si el modelo falla, cae al heurístico. */
export function tonoLlm(model = FAST_MODEL): ToneChecker {
  const m = chatModel(model).withStructuredOutput(z.object({ probabilidad: z.number().min(0).max(1) }));
  return {
    name: `llm:${model}`,
    async respetuoso(mensaje) {
      try {
        const r = await m.invoke([
          { role: "system", content: "Evalúas mensajes de cobranza bancaria. Devuelve SOLO la probabilidad (0-1) de que el mensaje sea respetuoso, claro y no presione ni amenace." },
          { role: "user", content: `Mensaje: """${mensaje}"""` },
        ]);
        return r.probabilidad;
      } catch (e) {
        console.warn("[tono] LLM falló, uso heurístico:", e instanceof Error ? e.message : e);
        return tonoHeuristico.respetuoso(mensaje);
      }
    },
  };
}
