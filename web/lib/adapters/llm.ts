import { ChatOpenRouter } from "@langchain/openrouter";

export const hasLlm = () => Boolean(process.env.OPENROUTER_API_KEY);

/**
 * Modelos baratos por defecto (ids de OpenRouter; verificados en /api/v1/models con tools y structured_outputs).
 * AGENT_MODEL: razonamiento del agente. FAST_MODEL: decisiones rápidas y cliente simulado.
 * JEV_MODEL: motor de decisiones tipo System One (TypeSafe Jev) cuando DECISION_ENGINE=jev.
 */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "deepseek/deepseek-v4-flash";
export const FAST_MODEL = process.env.FAST_MODEL ?? "deepseek/deepseek-v4-flash";
export const JEV_MODEL = process.env.JEV_MODEL ?? "typesafe/jev-router";

export function chatModel(model: string, temperature = 0) {
  return new ChatOpenRouter({
    model,
    temperature,
    maxTokens: 1500,
    apiKey: process.env.OPENROUTER_API_KEY,
    // Prioriza el proveedor más rápido (la latencia entre proveedores varía mucho) y exige soporte de tools/structured output.
    provider: { sort: "latency", require_parameters: true },
  });
}
