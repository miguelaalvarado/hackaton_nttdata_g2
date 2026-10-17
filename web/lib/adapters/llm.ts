import { ChatOpenRouter } from "@langchain/openrouter";

export const hasLlm = () => Boolean(process.env.OPENROUTER_API_KEY);

/** Modelos baratos de OpenRouter (con tools y structured outputs). AGENT_MODEL: Gestor. FAST_MODEL: cliente simulado y tono. */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "deepseek/deepseek-v4-flash";
export const FAST_MODEL = process.env.FAST_MODEL ?? "deepseek/deepseek-v4-flash";

export function chatModel(model: string, temperature = 0) {
  return new ChatOpenRouter({
    model,
    temperature,
    maxTokens: 1500,
    apiKey: process.env.OPENROUTER_API_KEY,
    // Prioriza el proveedor más rápido y exige soporte de tools/structured output.
    provider: { sort: "latency", require_parameters: true },
  });
}
