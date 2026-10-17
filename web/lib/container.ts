import { clienteLlm } from "./adapters/cliente-llm";
import { hasLlm } from "./adapters/llm";
import { gestorLlm } from "./adapters/gestor-llm";
import { modeloLogistico } from "./adapters/modelo-logistico";
import { clienteScripted, gestorScripted } from "./adapters/scripted";
import { sqliteCartera, sqliteGestiones, sqliteKpis, sqlitePagos, sqliteReglas } from "./adapters/sqlite";
import { tonoHeuristico, tonoLlm } from "./adapters/tono";
import { analizar } from "./core/analista";
import type { Ctx } from "./core/orquestador";
import type { ClienteSimulator, GestorAgent } from "./core/ports";

/**
 * Composition root: único lugar donde se eligen implementaciones.
 *  - OPENROUTER_API_KEY: Gestor, cliente simulado y revisión de tono con LLM (DeepSeek por defecto); sin ella, versiones por reglas.
 *  - AGENTS=llm|scripted  fuerza una opción.
 *  - Si se pide LLM y no hay credenciales, se ejecutan reglas y el Ctx lo declara en `degradado` (nunca se etiqueta como LLM).
 *  - Fase 3: reemplazar los repositorios sqlite* por adaptadores de Supabase/Postgres (mismos puertos).
 */
const usarLlm = () => (process.env.AGENTS ?? (hasLlm() ? "llm" : "scripted")) === "llm";

export const repos = { cartera: sqliteCartera, gestiones: sqliteGestiones, reglas: sqliteReglas, kpis: sqliteKpis, pagos: sqlitePagos };

/** Si el LLM falla (red, cuota, salida inválida) el turno se resuelve con reglas y queda ETIQUETADO como fallback. */
export function gestorConRespaldo(principal: GestorAgent, respaldo: GestorAgent): GestorAgent {
  return {
    name: `${principal.name} (respaldo: ${respaldo.name})`,
    async turno(input) {
      try {
        return await principal.turno(input);
      } catch (e) {
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        console.warn("[gestor] el LLM falló; se usan reglas:", error);
        const t = await respaldo.turno(input);
        return { ...t, meta: { ...(t.meta ?? {}), motor: "fallback", modelo: principal.name, error } };
      }
    },
  };
}

export function clienteConRespaldo(principal: ClienteSimulator, respaldo: ClienteSimulator): ClienteSimulator {
  return {
    name: `${principal.name} (respaldo: ${respaldo.name})`,
    async responder(input) {
      try {
        return await principal.responder(input);
      } catch (e) {
        console.warn("[cliente simulado] el LLM falló; se usan reglas:", e instanceof Error ? e.message : e);
        return respaldo.responder(input);
      }
    },
  };
}

function build(modo: "llm" | "scripted"): Ctx {
  return {
    cartera: repos.cartera,
    gestiones: repos.gestiones,
    reglasRepo: repos.reglas,
    pagos: repos.pagos,
    modelo: modeloLogistico,
    gestor: modo === "llm" ? gestorConRespaldo(gestorLlm(), gestorScripted) : gestorScripted,
    cliente: modo === "llm" ? clienteConRespaldo(clienteLlm(), clienteScripted) : clienteScripted,
    tono: modo === "llm" ? tonoLlm() : tonoHeuristico,
    ahora: () => new Date(),
    modoSolicitado: modo,
  };
}

type G = { __ctx?: Record<string, Ctx>; __scored?: Promise<void> };
const g = globalThis as unknown as G;

/** Puntúa la cartera la primera vez (el Analista escribe prob_no_pago, causa y prioridad). */
async function asegurarAnalisis() {
  return (g.__scored ??= (async () => {
    const todos = await repos.cartera.list();
    for (const c of todos) {
      if (c.prob_no_pago === null) {
        const a = analizar(c, modeloLogistico);
        await repos.cartera.actualizarAnalisis(c.cliente_id, a);
      }
    }
  })());
}

export async function getCtx(modo?: "llm" | "scripted"): Promise<Ctx> {
  await asegurarAnalisis();
  const pedido = modo ?? (usarLlm() ? "llm" : "scripted");
  g.__ctx ??= {};
  if (pedido === "llm" && !hasLlm()) {
    // Sin credenciales NO se simula un LLM: se corre con reglas y se declara.
    return (g.__ctx["degradado"] ??= { ...build("scripted"), modoSolicitado: "llm", degradado: "LLM no disponible: falta OPENROUTER_API_KEY; se ejecutaron reglas." });
  }
  return (g.__ctx[pedido] ??= build(pedido));
}

export function reiniciarCache() {
  g.__scored = undefined;
  g.__ctx = undefined;
}

export const modoActual = () => (usarLlm() ? "llm" : "scripted");
export const llmDisponible = () => hasLlm();
