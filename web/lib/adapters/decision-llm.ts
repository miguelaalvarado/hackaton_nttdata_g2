import { z } from "zod";
import type { DecisionEngine } from "../core/ports";
import { FAST_MODEL, chatModel } from "./llm";

const SYSTEM =
  "Eres un motor de decisión rápido. Respondes SOLO con la estructura pedida. " +
  "confidence/probability es tu confianza calibrada (0-1). No expliques.";

/** DecisionEngine sobre un LLM rápido (OpenRouter + salida estructurada). */
export function llmDecisionEngine(model = FAST_MODEL): DecisionEngine {
  const m = chatModel(model);
  const ask = async <S extends z.ZodType>(schema: S, prompt: string): Promise<z.infer<S>> => {
    const out = await m.withStructuredOutput(schema).invoke([
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ]);
    return out as z.infer<S>;
  };

  return {
    name: `llm:${model}`,
    async choose({ question, context, options }) {
      const schema = z.object({ choice: z.enum([...options] as unknown as [string, ...string[]]), confidence: z.number().min(0).max(1) });
      const r = await ask(schema, `${question}\nOpciones: ${options.join(", ")}\nContexto: ${context}`);
      return { choice: r.choice as (typeof options)[number], confidence: r.confidence };
    },
    async yesNo({ question, context }) {
      const r = await ask(z.object({ probability: z.number().min(0).max(1) }), `${question}\nContexto: ${context}\nDevuelve la probabilidad de que la respuesta sea SÍ.`);
      return { probability: r.probability };
    },
    async score({ rubric, context, tiers }) {
      const r = await ask(
        z.object({ score: z.number().int().min(1).max(tiers), confidence: z.number().min(0).max(1) }),
        `Puntúa de 1 a ${tiers} según la rúbrica.\nRúbrica: ${rubric}\nContexto: ${context}`,
      );
      return r;
    },
  };
}
