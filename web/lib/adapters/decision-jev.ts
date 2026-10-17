import type { DecisionEngine } from "../core/ports";
import { llmDecisionEngine } from "./decision-llm";
import { JEV_MODEL } from "./llm";

/**
 * Jev (TypeSafe AI, modelo "System One" de decisiones tipadas) vía OpenRouter.
 *
 * OpenRouter lista `typesafe/jev-router` (router sobre Jev, soporta structured_outputs y logprobs). Se usa con la
 * misma interfaz de salida estructurada que cualquier otro modelo, así que reutiliza el adaptador LLM.
 * No se verificó en vivo (requiere API key y, al revisar, el modelo no exponía endpoints activos): por eso el
 * contenedor lo envuelve en una cadena con respaldo. Si TypeSafe publica las primitivas nativas
 * (Choice/Score/Yes-No con distribución de probabilidad), implementarlas aquí sin tocar el resto.
 */
export function jevDecisionEngine(model = JEV_MODEL): DecisionEngine {
  const inner = llmDecisionEngine(model);
  return { ...inner, name: `jev:${model}` };
}
