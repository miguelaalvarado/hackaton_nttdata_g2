import { economics } from "./channels";
import type { CollectionAgent, ComplianceGuard, CustomerSimulator, DecisionEngine, PortfolioRepository, RiskScorer } from "./ports";
import { OUTCOMES, type ContactAttempt, type Outcome, type Proposal } from "./types";

export type Deps = {
  portfolio: PortfolioRepository;
  scorer: RiskScorer;
  decision: DecisionEngine;
  agent: CollectionAgent;
  customer: CustomerSimulator;
  compliance: ComplianceGuard;
};

/** Casos de uso. Solo conoce los puertos: cualquier adaptador es intercambiable. */
export function createService(d: Deps) {
  return {
    names: { agent: d.agent.name, decision: d.decision.name, customer: d.customer.name },

    async propose(clientId: string, history: ContactAttempt[]) {
      const client = await d.portfolio.get(clientId);
      if (!client) throw new Error(`Cliente no encontrado: ${clientId}`);
      const risk = await d.scorer.assess(client);

      const { draft, trace } = await d.agent.propose({ client, history });
      const proposal: Proposal = { ...draft, ...economics(client, risk, history, draft.channel) };
      const compliance = await d.compliance.review({ client, proposal, history });
      return { proposal, trace, compliance, risk };
    },

    /** Revisa un mensaje editado por el gestor sin volver a llamar al agente. */
    async review(clientId: string, proposal: Proposal, history: ContactAttempt[]) {
      const client = await d.portfolio.get(clientId);
      if (!client) throw new Error(`Cliente no encontrado: ${clientId}`);
      return d.compliance.review({ client, proposal, history });
    },

    /** Envía (simulado), recibe la respuesta del cliente y la clasifica con el motor de decisión. */
    async respond(clientId: string, proposal: Proposal, history: ContactAttempt[]) {
      const client = await d.portfolio.get(clientId);
      if (!client) throw new Error(`Cliente no encontrado: ${clientId}`);
      const reply = await d.customer.reply({ client, proposal, history });
      const decision = await d.decision.choose<Outcome>({
        id: "customer_outcome",
        question: "¿Cuál es el resultado de este contacto de cobranza según la respuesta del cliente?",
        context: reply || "(sin respuesta)",
        options: OUTCOMES,
      });
      const attempt: ContactAttempt = {
        round: history.length + 1,
        channel: proposal.channel,
        offer: proposal.offer,
        message: proposal.message,
        customer_reply: reply,
        outcome: decision.choice,
      };
      return { attempt, confidence: decision.confidence };
    },
  };
}

export type Service = ReturnType<typeof createService>;
