import type { RiskModel } from "./ports";
import type { ClientePublico } from "./types";

export const ETIQUETA_VARIABLE: Record<string, string> = {
  sin_sueldo: "el sueldo no llegó este mes",
  cobertura_cuota: "saldo en cuenta bajo frente a la cuota",
  uso_linea: "uso alto de la línea de crédito",
  atrasos_6m: "atrasos en los últimos 6 meses",
  dias_atraso_30: "días de atraso actuales",
};

export type Analisis = { prob_no_pago: number; causa_probable: string; prioridad: "alta" | "media" | "baja"; justificacion: string };

/** Analista: probabilidad de no pago (modelo), causa probable (reglas) y prioridad. */
export function analizar(c: ClientePublico, model: RiskModel): Analisis {
  const p = model.probabilidad(c);
  const causa = !c.sueldo_llego_mes ? "retraso_ingresos"
    : c.saldo_cuenta < c.monto_cuota || c.uso_linea_tc_pct > 80 ? "iliquidez"
    : "olvido";
  const prioridad = p >= 0.55 ? "alta" : p >= 0.3 ? "media" : "baja";
  const top = model.explicar(c).filter((a) => a.aporte > 0.15).slice(0, 3).map((a) => ETIQUETA_VARIABLE[a.variable] ?? a.variable);
  return {
    prob_no_pago: Number(p.toFixed(3)),
    causa_probable: causa,
    prioridad,
    justificacion: `Riesgo ${(p * 100).toFixed(0)} %${top.length ? ` por: ${top.join("; ")}` : ""}. Causa probable: ${causa.replace("_", " ")}.`,
  };
}

/** Propone día y hora de contacto según la ventana en la que el cliente suele responder. */
export function proponerSlot(c: ClientePublico, ahora: Date, hoyIso: string, diasExtra = 0): { fecha: string; hora: string } {
  const [h0] = c.hora_respuesta.split("-").map(Number);
  const hora = `${String(h0).padStart(2, "0")}:30`;
  const pasado = ahora.getHours() * 60 + ahora.getMinutes() > h0 * 60 + 30;
  const d = new Date(`${hoyIso}T12:00:00`);
  d.setDate(d.getDate() + (pasado ? 1 : 0) + diasExtra);
  const p = (n: number) => String(n).padStart(2, "0");
  return { fecha: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hora };
}
