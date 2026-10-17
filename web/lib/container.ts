import { clienteLlm } from "./adapters/cliente-llm";
import { hasLlm } from "./adapters/llm";
import { gestorLlm } from "./adapters/gestor-llm";
import { modeloLogistico } from "./adapters/modelo-logistico";
import { clienteScripted, gestorScripted } from "./adapters/scripted";
import { sqliteCartera, sqliteGestiones, sqliteKpis, sqliteReglas } from "./adapters/sqlite";
import { tonoHeuristico, tonoLlm } from "./adapters/tono";
import { analizar } from "./core/analista";
import type { Ctx } from "./core/orquestador";

/**
 * Composition root: único lugar donde se eligen implementaciones.
 *  - OPENROUTER_API_KEY: Gestor, cliente simulado y revisión de tono con LLM (DeepSeek por defecto); sin ella, versiones por reglas.
 *  - AGENTS=llm|scripted  fuerza una opción.
 *  - Fase 3: reemplazar los repositorios sqlite* por adaptadores de Supabase/Postgres (mismos puertos).
 */
const usarLlm = () => (process.env.AGENTS ?? (hasLlm() ? "llm" : "scripted")) === "llm";

export const repos = { cartera: sqliteCartera, gestiones: sqliteGestiones, reglas: sqliteReglas, kpis: sqliteKpis };

function build(modo: "llm" | "scripted"): Ctx {
  return {
    cartera: repos.cartera,
    gestiones: repos.gestiones,
    reglasRepo: repos.reglas,
    modelo: modeloLogistico,
    gestor: modo === "llm" ? gestorLlm() : gestorScripted,
    cliente: modo === "llm" ? clienteLlm() : clienteScripted,
    tono: modo === "llm" ? tonoLlm() : tonoHeuristico,
    ahora: () => new Date(),
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
  const m = modo ?? (usarLlm() ? "llm" : "scripted");
  g.__ctx ??= {};
  return (g.__ctx[m] ??= build(m));
}

export function reiniciarCache() {
  g.__scored = undefined;
  g.__ctx = undefined;
}

export const modoActual = () => (usarLlm() ? "llm" : "scripted");
