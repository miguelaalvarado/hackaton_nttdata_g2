import { ChatOpenRouter } from "@langchain/openrouter";
import { registrarLlmCall } from "./sqlite";

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

export type Uso = { tokens_in: number | null; tokens_out: number | null };

/** Lee el uso de tokens que DEVUELVE el proveedor. Si no lo informa, null ("No disponible"); nunca se estima ni se inventa. */
export function extraerUso(msg: unknown): Uso {
  const m = msg as { usage_metadata?: Record<string, unknown>; response_metadata?: Record<string, Record<string, unknown>> } | null | undefined;
  const u = m?.usage_metadata ?? m?.response_metadata?.tokenUsage ?? m?.response_metadata?.usage;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    tokens_in: n(u?.input_tokens) ?? n(u?.promptTokens) ?? n(u?.prompt_tokens),
    tokens_out: n(u?.output_tokens) ?? n(u?.completionTokens) ?? n(u?.completion_tokens),
  };
}

/** Ejecuta una llamada al LLM midiendo latencia y uso, y la registra en `llm_calls` (éxito o fallo). */
export async function medir<T>(rol: string, modelo: string, clienteId: string | null, fn: () => Promise<{ valor: T; raw?: unknown }>) {
  const t0 = Date.now();
  try {
    const { valor, raw } = await fn();
    const uso = extraerUso(raw);
    const latencia_ms = Date.now() - t0;
    await registrarLlmCall({ cliente_id: clienteId, rol, modelo, latencia_ms, ...uso, ok: true });
    return { valor, latencia_ms, ...uso };
  } catch (e) {
    await registrarLlmCall({ cliente_id: clienteId, rol, modelo, latencia_ms: Date.now() - t0, tokens_in: null, tokens_out: null, ok: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
