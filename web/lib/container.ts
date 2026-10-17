import { createComplianceGuard } from "./core/compliance";
import { withFallback } from "./core/decision-fallback";
import { createService, type Service } from "./core/service";
import { langchainAgent } from "./adapters/agent-langchain";
import { scriptedAgent } from "./adapters/agent-scripted";
import { llmCustomer, scriptedCustomer } from "./adapters/customer";
import { heuristicDecisionEngine } from "./adapters/decision-heuristic";
import { jevDecisionEngine } from "./adapters/decision-jev";
import { llmDecisionEngine } from "./adapters/decision-llm";
import { hasLlm } from "./adapters/llm";
import { jsonPortfolio, precomputedScorer } from "./adapters/portfolio-json";

/**
 * Único lugar donde se eligen implementaciones (composition root). Variables de entorno:
 *  - OPENROUTER_API_KEY: activa agente y cliente simulado con LLM; sin ella se usan versiones sin red.
 *  - AGENT_MODEL / FAST_MODEL: modelos de OpenRouter para el agente y para las decisiones rápidas.
 *  - AGENT=scripted|langchain, DECISION_ENGINE=heuristic|llm|jev, CUSTOMER=scripted|llm  (fuerzan una opción)
 */
function build(): Service {
  const llm = hasLlm();
  const agentKind = process.env.AGENT ?? (llm ? "langchain" : "scripted");
  const decisionKind = process.env.DECISION_ENGINE ?? (llm ? "llm" : "heuristic");
  const customerKind = process.env.CUSTOMER ?? (llm ? "llm" : "scripted");

  // Cadenas con respaldo: ante un fallo del modelo se baja al siguiente, hasta las reglas locales.
  const decision =
    decisionKind === "jev"
      ? withFallback([jevDecisionEngine(), llmDecisionEngine(), heuristicDecisionEngine])
      : decisionKind === "llm"
        ? withFallback([llmDecisionEngine(), heuristicDecisionEngine])
        : heuristicDecisionEngine;

  return createService({
    portfolio: jsonPortfolio,
    scorer: precomputedScorer,
    decision,
    agent: agentKind === "langchain" ? langchainAgent(precomputedScorer) : scriptedAgent(precomputedScorer),
    customer: customerKind === "llm" ? llmCustomer() : scriptedCustomer,
    compliance: createComplianceGuard(decision),
  });
}

const g = globalThis as unknown as { __service?: Service };
export const getService = (): Service => (g.__service ??= build());
