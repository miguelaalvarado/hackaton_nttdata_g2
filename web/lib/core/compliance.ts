import type { ComplianceGuard, DecisionEngine } from "./ports";
import type { ComplianceCheck, ComplianceResult } from "./types";

const MAX_CONTACTS_PER_WEEK = 3;
const HOURS = { from: 8, to: 20 };
const FORBIDDEN = ["embargo", "denuncia", "policía", "policia", "cárcel", "carcel", "familiares", "vecinos", "demanda judicial"];

/** Reglas determinísticas + una decisión Yes/No del DecisionEngine sobre el tono. */
export function createComplianceGuard(decision: DecisionEngine): ComplianceGuard {
  return {
    async review({ client, proposal, history }) {
      const checks: ComplianceCheck[] = [];

      const inWindow = proposal.send_hour >= HOURS.from && proposal.send_hour <= HOURS.to;
      checks.push({
        id: "horario",
        label: "Horario de contacto permitido",
        status: inWindow ? "ok" : "block",
        detail: `${proposal.send_hour}:00 (permitido ${HOURS.from}:00-${HOURS.to}:00)`,
      });

      const contacts = history.length + 1;
      checks.push({
        id: "frecuencia",
        label: "Máximo de contactos por semana",
        status: contacts <= MAX_CONTACTS_PER_WEEK ? "ok" : "block",
        detail: `${contacts} de ${MAX_CONTACTS_PER_WEEK} contactos`,
      });

      const lower = proposal.message.toLowerCase();
      const hit = FORBIDDEN.find((w) => lower.includes(w));
      checks.push({
        id: "lenguaje",
        label: "Sin lenguaje de amenaza",
        status: hit ? "block" : "ok",
        detail: hit ? `Contiene "${hit}"` : "Sin términos prohibidos",
      });

      const tone = await decision.yesNo({
        id: "message_tone_ok",
        question: "¿El mensaje es respetuoso, claro y no presiona ni amenaza indebidamente al cliente?",
        context: `Cliente: ${client.name}. Mensaje: """${proposal.message}"""`,
      });
      checks.push({
        id: "tono",
        label: "Tono respetuoso (motor de decisión)",
        status: tone.probability >= 0.7 ? "ok" : tone.probability >= 0.4 ? "warn" : "block",
        detail: `Probabilidad de cumplir: ${(tone.probability * 100).toFixed(0)} %`,
      });

      const status: ComplianceResult["status"] = checks.some((c) => c.status === "block")
        ? "block"
        : checks.some((c) => c.status === "warn")
          ? "warn"
          : "ok";
      if (status !== "ok") {
        const bad = checks.filter((c) => c.status !== "ok").map((c) => `${c.id}:${c.status}(${c.detail})`);
        console.warn(`[compliance] ${status} ${client.id}: ${bad.join("; ")} | msg="${proposal.message.slice(0, 120)}"`);
      }
      return { status, checks };
    },
  };
}
