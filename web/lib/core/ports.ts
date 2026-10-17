/**
 * Puertos (interfaces) del dominio. La lógica de negocio solo depende de esto;
 * cada implementación concreta vive en lib/adapters y se elige en lib/container.ts.
 */
import type {
  Client, ComplianceResult, ContactAttempt, Proposal, ProposalDraft, RiskAssessment, TraceStep,
} from "./types";

/** De dónde salen los clientes (JSON hoy; DB, API del core bancario, etc. mañana). */
export interface PortfolioRepository {
  list(): Promise<Client[]>;
  get(id: string): Promise<Client | undefined>;
}

/** Quién calcula la probabilidad de mora (valores precalculados hoy; servicio de ML mañana). */
export interface RiskScorer {
  assess(client: Client): Promise<RiskAssessment>;
}

/**
 * Motor de decisiones rápidas tipo "IF de IA": elegir una opción, puntuar con una rúbrica o responder sí/no,
 * siempre con salida tipada y confianza. Mismas primitivas que los modelos "System One" (p. ej. Jev):
 * Choice, Score y Yes/No. Implementable con un LLM, con reglas, o con un modelo de decisión dedicado.
 */
export interface DecisionEngine {
  readonly name: string;
  choose<T extends string>(q: {
    id: string;
    question: string;
    context: string;
    options: readonly T[];
  }): Promise<{ choice: T; confidence: number }>;
  yesNo(q: { id: string; question: string; context: string }): Promise<{ probability: number }>;
  score(q: { id: string; rubric: string; context: string; tiers: number }): Promise<{ score: number; confidence: number }>;
}

/** Agente que razona con herramientas y propone el contacto (LangChain hoy; otro framework mañana). */
export interface CollectionAgent {
  readonly name: string;
  propose(input: { client: Client; history: ContactAttempt[] }): Promise<{ draft: ProposalDraft; trace: TraceStep[] }>;
}

/** Simula al cliente para poder cerrar el ciclo de feedback en la demo. */
export interface CustomerSimulator {
  readonly name: string;
  reply(input: { client: Client; proposal: Proposal; history: ContactAttempt[] }): Promise<string>;
}

export interface ComplianceGuard {
  review(input: { client: Client; proposal: Proposal; history: ContactAttempt[] }): Promise<ComplianceResult>;
}
