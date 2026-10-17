import type { ActorId, TurnoMeta } from "@/lib/core/types";

/** Etiqueta honesta de qué motor ejecutó un paso. "LLM real" solo si la traza de ESE paso lo prueba. */
export function MotorBadge({ de, meta }: { de: ActorId; meta?: TurnoMeta }) {
  if (de === "gestor" && meta) {
    if (meta.motor === "llm") {
      const t = meta.tokens_in == null && meta.tokens_out == null ? "tokens: no disponible" : `${meta.tokens_in ?? "?"}→${meta.tokens_out ?? "?"} tokens`;
      return <span className="motor llm" title={`${meta.modelo} · ${meta.latencia_ms} ms · ${t}`}>LLM real · {meta.modelo?.split("/").pop()} · {meta.latencia_ms} ms · {t}</span>;
    }
    if (meta.motor === "fallback") return <span className="motor fallback" title={meta.error}>Fallback a reglas (el LLM falló)</span>;
    return <span className="motor reglas">Reglas (sin LLM)</span>;
  }
  if (de === "cliente") return <span className="motor sim">Simulación</span>;
  if (de === "humano") return <span className="motor humano">Humano</span>;
  if (de === "analista") return <span className="motor reglas">Modelo logístico</span>;
  if (de === "supervisor") return <span className="motor reglas">Reglas determinísticas</span>;
  if (de === "gestor") return <span className="motor reglas">Reglas (sin LLM)</span>;
  return null;
}
