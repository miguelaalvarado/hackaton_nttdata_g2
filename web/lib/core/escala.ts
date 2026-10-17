/**
 * Simulador de escala (3-4 M de clientes). ARITMÉTICA sobre supuestos editables: no es una medición ni un ROI validado.
 * Compara procesar TODOS los casos elegibles con LLM frente a activar el LLM solo donde hace falta.
 */
export type ParamsEscala = {
  clientes: number;
  pctElegible: number;       // % de la cartera en cobranza temprana
  pctLlm: number;            // % de los elegibles que requieren LLM (activación selectiva)
  tokensInPorCaso: number;
  tokensOutPorCaso: number;
  precioInUsdPorM: number;   // USD por millón de tokens de entrada
  precioOutUsdPorM: number;  // USD por millón de tokens de salida
  usdPen: number;            // tipo de cambio S/ por USD
  costoInfraPen: number;     // costo fijo de infraestructura del periodo (S/)
  contactosPorCaso: number;
  costoCanalPen: number;     // costo por contacto (S/)
  pctRespuesta: number;      // % de los contactados que responde (supuesto)
  deudaPromedioPen: number;
  recuperacionIncrementalPp: number; // puntos porcentuales de la deuda recuperados de más, entre quienes responden (HIPOTÉTICO)
};

export type ResultadoEstrategia = {
  casosLlm: number; tokensIn: number; tokensOut: number; costoLlmPen: number; costoCanalPen: number; costoInfraPen: number;
  costoTotalPen: number; costoPorCuentaPen: number; beneficioHipoteticoPen: number; netoPen: number; roi: number | null;
  /** Recuperación incremental mínima (pp) para que el beneficio iguale el costo; no depende de la hipótesis de recuperación. */
  puntoEquilibrioPp: number | null;
};

const pct = (n: number) => n / 100;

export function validarParams(p: ParamsEscala): string | null {
  for (const [k, v] of Object.entries(p)) if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `${k} debe ser un número ≥ 0`;
  for (const k of ["pctElegible", "pctLlm", "pctRespuesta"] as const) if (p[k] > 100) return `${k} no puede superar 100`;
  return null;
}

function estrategia(p: ParamsEscala, elegibles: number, casosLlm: number): ResultadoEstrategia {
  const tokensIn = casosLlm * p.tokensInPorCaso, tokensOut = casosLlm * p.tokensOutPorCaso;
  const costoLlmPen = ((tokensIn * p.precioInUsdPorM + tokensOut * p.precioOutUsdPorM) / 1_000_000) * p.usdPen;
  const costoCanalPen = elegibles * p.contactosPorCaso * p.costoCanalPen;
  const costoTotalPen = costoLlmPen + costoCanalPen + p.costoInfraPen;
  const baseRecuperable = elegibles * pct(p.pctRespuesta) * p.deudaPromedioPen;
  const beneficio = baseRecuperable * pct(p.recuperacionIncrementalPp);
  return {
    casosLlm, tokensIn, tokensOut, costoLlmPen, costoCanalPen, costoInfraPen: p.costoInfraPen, costoTotalPen,
    costoPorCuentaPen: elegibles ? costoTotalPen / elegibles : 0, beneficioHipoteticoPen: beneficio, netoPen: beneficio - costoTotalPen,
    roi: costoTotalPen > 0 ? (beneficio - costoTotalPen) / costoTotalPen : null,
    puntoEquilibrioPp: baseRecuperable > 0 ? (costoTotalPen / baseRecuperable) * 100 : null,
  };
}

export function simularEscala(p: ParamsEscala) {
  const err = validarParams(p);
  if (err) throw new Error(err);
  const elegibles = p.clientes * pct(p.pctElegible);
  return { elegibles, masivo: estrategia(p, elegibles, elegibles), selectivo: estrategia(p, elegibles, elegibles * pct(p.pctLlm)) };
}

/** Valores de EJEMPLO para que la pantalla muestre números; no son tarifas ni tasas reales y se editan en la UI. */
export const PARAMS_EJEMPLO: ParamsEscala = {
  clientes: 3_000_000, pctElegible: 10, pctLlm: 15, tokensInPorCaso: 2500, tokensOutPorCaso: 600,
  precioInUsdPorM: 0.3, precioOutUsdPorM: 1.2, usdPen: 3.75, costoInfraPen: 20_000,
  contactosPorCaso: 1.5, costoCanalPen: 0.1, pctRespuesta: 40, deudaPromedioPen: 1200, recuperacionIncrementalPp: 0.1,
};

/** Costo por contacto de cada canal: SUPUESTOS de ejemplo (no tarifas reales); se editan en el dashboard. */
export const COSTO_CANAL_EJEMPLO_PEN: Record<string, number> = { whatsapp: 0.1, sms: 0.08, llamada: 2.0 };
