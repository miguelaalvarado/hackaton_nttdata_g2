import { z } from "zod";
import type { Client } from "../portfolio";

export type { Client };

export const CHANNELS = ["push_sms", "whatsapp", "email", "llamada_preventiva", "llamada_asesor", "gestion_avanzada"] as const;
export type Channel = (typeof CHANNELS)[number];

export const OFFERS = ["recordatorio", "reprogramacion", "plan_de_pagos", "refinanciamiento", "aclaracion_de_cobro"] as const;
export type Offer = (typeof OFFERS)[number];

export const OUTCOMES = ["pagara", "pide_plazo", "no_puede_pagar", "rechaza", "sin_respuesta"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Lo que decide el agente (texto y elecciones). Las cifras las calcula el código, no el LLM. */
export const ProposalDraftSchema = z.object({
  channel: z.enum(CHANNELS).describe("Canal de contacto elegido"),
  offer: z.enum(OFFERS).describe("Oferta o acción propuesta al cliente"),
  send_hour: z.number().int().min(0).max(23).describe("Hora local del día para contactar (0-23)"),
  tone: z.enum(["cercano", "formal", "urgente_respetuoso"]),
  message: z.string().describe("Mensaje al cliente en español, breve y respetuoso, sin amenazas"),
  rationale: z.string().describe("Por qué este canal/oferta/horario para este cliente, citando datos de las herramientas"),
});
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

export type Proposal = ProposalDraft & {
  expected_cost: number;
  expected_loss: number;
  expected_loss_avoided: number;
  net_value: number;
};

export type ContactAttempt = {
  round: number;
  channel: Channel;
  offer: Offer;
  message: string;
  customer_reply: string;
  outcome: Outcome;
};

export type TraceStep =
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "tool_result"; name: string; content: string }
  | { kind: "note"; content: string };

export type RiskAssessment = {
  pd: number;
  band: "alto" | "medio" | "bajo";
  reasons: { factor: string; impact_pp: number }[];
};

export type ChannelOption = {
  channel: Channel;
  label: string;
  cost: number;
  effectiveness: number; // reducción relativa esperada de la pérdida (0-1) tras el ajuste por historial
  expected_loss_avoided: number;
  net_value: number;
  note?: string;
};

export type ComplianceCheck = { id: string; label: string; status: "ok" | "warn" | "block"; detail: string };
export type ComplianceResult = { status: "ok" | "warn" | "block"; checks: ComplianceCheck[] };
