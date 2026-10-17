import modelo from "../../seed/modelo.json";
import type { RiskModel } from "../core/ports";
import type { ClientePublico } from "../core/types";

export const MODELO_METRICAS = modelo.metricas;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Variables del modelo (mismas transformaciones que src/gen_cartera.py). */
export function variables(c: ClientePublico): Record<string, number> {
  return {
    sin_sueldo: c.sueldo_llego_mes ? 0 : 1,
    cobertura_cuota: Math.min(Math.max(c.saldo_cuenta / c.monto_cuota, 0), 3),
    uso_linea: c.uso_linea_tc_pct / 100,
    atrasos_6m: c.atrasos_ult_6m,
    dias_atraso_30: c.dias_atraso / 30,
  };
}

/** Regresión logística entrenada offline; se evalúa en TS sin runtime de ML (apta para Vercel). */
export const modeloLogistico: RiskModel = {
  name: "regresión logística (cartera sintética)",
  probabilidad(c) {
    const x = variables(c);
    const z = modelo.features.reduce((s, f, i) => s + modelo.coef[i] * x[f], modelo.intercept);
    return sigmoid(z);
  },
  explicar(c) {
    const x = variables(c);
    return modelo.features.map((f, i) => ({ variable: f, aporte: modelo.coef[i] * x[f] })).sort((a, b) => b.aporte - a.aporte);
  },
};


