import type { DecisionEngine } from "./ports";

/** Prueba los motores en orden y usa el primero que no falle (p. ej. Jev -> LLM barato -> reglas). */
export function withFallback(engines: DecisionEngine[]): DecisionEngine {
  const run = async <R>(call: (e: DecisionEngine) => Promise<R>): Promise<R> => {
    let last: unknown;
    for (const e of engines) {
      try {
        return await call(e);
      } catch (err) {
        last = err;
        console.warn(`[decision] ${e.name} falló, probando el siguiente:`, err instanceof Error ? err.message : err);
      }
    }
    throw last;
  };
  return {
    name: engines.map((e) => e.name).join(" → "),
    choose: (q) => run((e) => e.choose(q)),
    yesNo: (q) => run((e) => e.yesNo(q)),
    score: (q) => run((e) => e.score(q)),
  };
}
