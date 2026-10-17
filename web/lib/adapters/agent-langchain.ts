import { createAgent, tool, toolStrategy } from "langchain";
import { z } from "zod";
import { channelOptions } from "../core/channels";
import type { CollectionAgent, RiskScorer } from "../core/ports";
import { CHANNELS, ProposalDraftSchema, type Client, type ContactAttempt, type TraceStep } from "../core/types";
import { AGENT_MODEL, chatModel } from "./llm";

const SYSTEM = `Eres un agente de cobranza temprana de un banco. Tu objetivo: elegir el próximo contacto óptimo para UN cliente,
minimizando la pérdida esperada neta del costo del canal, con trato respetuoso.

Reglas:
- Usa SIEMPRE las herramientas antes de decidir: perfil, señales semanales, evaluación de riesgo y opciones de canal.
- Solo cita cifras que devuelvan las herramientas; nunca inventes números.
- Si hay historial de contactos fallidos, CAMBIA de canal y/o de oferta y explica qué aprendiste de la respuesta del cliente.
- Ajusta la oferta a la causa probable: olvido -> recordatorio; falta de liquidez -> reprogramación o plan de pagos; deuda muy alta -> refinanciamiento.
- Si el cliente rechaza o disputa el cobro (dice que ya pagó, que es un error, o se queja), NO escales a canales más invasivos: ofrece "aclaracion_de_cobro" por un canal escrito y respetuoso.
- Si no responde por un canal impersonal (correo, SMS), prueba uno más directo (WhatsApp o llamada) antes de escalar a gestión avanzada.
- El mensaje debe estar listo para enviar: NUNCA uses marcadores como [Nombre] ni inventes nombres de asesor; firma como "tu banco" y no inventes teléfonos.
- Mensaje en español, claro, cercano y sin amenazas ni presión indebida. Horario de contacto entre 8 y 20 h.
- La rationale debe ser concreta (2-4 frases) y citar señales, PD y costo/beneficio del canal.`;

/** Agente ReAct de LangChain con herramientas sobre los puertos del dominio. */
export function langchainAgent(scorer: RiskScorer, model = AGENT_MODEL): CollectionAgent {
  return {
    name: `langchain:${model}`,
    async propose({ client, history }) {
      const tools = buildTools(client, history, scorer);
      const agent = createAgent({
        model: chatModel(model, 0.2),
        tools,
        systemPrompt: SYSTEM,
        responseFormat: toolStrategy(ProposalDraftSchema),
      });
      const t0 = Date.now();
      const result = await agent.invoke({
        messages: [
          {
            role: "user",
            content: history.length
              ? `Replanifica el contacto para ${client.id}. Ya hubo ${history.length} intento(s); revisa el historial con la herramienta y cambia de táctica.`
              : `Propón el primer contacto para el cliente ${client.id}.`,
          },
        ],
      });
      const aiTurns = (result.messages as any[]).filter((m) => (m?.type ?? m?._getType?.()) === "ai").length;
      console.log(`[agent] ${client.id} ${Date.now() - t0}ms, ${aiTurns} turnos del modelo`);
      return { draft: ProposalDraftSchema.parse(result.structuredResponse), trace: extractTrace(result.messages) };
    },
  };
}

function buildTools(client: Client, history: ContactAttempt[], scorer: RiskScorer) {
  const noArgs = z.object({});
  return [
    tool(async () => JSON.stringify({
      id: client.id, nombre: client.name, edad: client.age, ingreso_mensual: client.monthly_income,
      limite_credito: client.credit_limit, exposicion: client.exposure_ead, lineas_abiertas: client.open_credit_lines,
      ratio_deuda_ingreso: client.debt_ratio,
      atrasos: { "30_59": client.late_30_59, "60_89": client.late_60_89, "90_mas": client.late_90_plus },
    }), { name: "get_client_profile", description: "Perfil y variables de crédito del cliente.", schema: noArgs }),

    tool(async () => {
      const s = client.signals_weekly;
      const last = <T,>(a: T[], n = 4) => a.slice(-n);
      return JSON.stringify({
        semanas: s.utilization.length,
        uso_de_linea_ultimas_4: last(s.utilization),
        uso_de_linea_hace_12_semanas: s.utilization[0],
        semanas_solo_pago_minimo: s.minimum_payment_only.reduce((a, b) => a + b, 0),
        transacciones_por_semana_primeras_4: s.transactions_per_week.slice(0, 4),
        transacciones_por_semana_ultimas_4: last(s.transactions_per_week),
      });
    }, { name: "get_weekly_signals", description: "Señales de comportamiento de las últimas 12 semanas (uso de línea, pagos mínimos, frecuencia de transacciones).", schema: noArgs }),

    tool(async () => JSON.stringify(await scorer.assess(client)), {
      name: "get_risk_assessment", description: "Probabilidad de mora (PD) del modelo y principales factores que la explican.", schema: noArgs,
    }),

    tool(async () => JSON.stringify(channelOptions(client, await scorer.assess(client), history)), {
      name: "list_channel_options",
      description: `Canales disponibles (${CHANNELS.join(", ")}) con costo, efectividad esperada, pérdida evitada y valor neto, ya ajustados por el historial de contactos. Ordenados por valor neto.`,
      schema: noArgs,
    }),

    tool(async () => JSON.stringify(history.length ? history : "Sin contactos previos."), {
      name: "get_contact_history", description: "Intentos de contacto previos con la respuesta del cliente y su resultado.", schema: noArgs,
    }),
  ];
}

/** Convierte los mensajes de LangChain en pasos legibles para la UI. */
const BUSINESS_TOOLS = new Set(["get_client_profile", "get_weekly_signals", "get_risk_assessment", "list_channel_options", "get_contact_history"]);

function extractTrace(messages: unknown[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const m of messages as any[]) {
    const type = m?.type ?? m?._getType?.();
    if (type === "ai") {
      for (const tc of m.tool_calls ?? []) {
        if (BUSINESS_TOOLS.has(tc.name)) steps.push({ kind: "tool_call", name: tc.name, args: tc.args });
      }
    } else if (type === "tool" && BUSINESS_TOOLS.has(m.name)) {
      steps.push({ kind: "tool_result", name: m.name, content: String(m.content).slice(0, 1200) });
    }
  }
  return steps;
}
