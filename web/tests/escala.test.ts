import { describe, expect, it } from "vitest";
import { PARAMS_EJEMPLO, simularEscala, validarParams, type ParamsEscala } from "@/lib/core/escala";

const base: ParamsEscala = {
  clientes: 3_000_000, pctElegible: 10, pctLlm: 20, tokensInPorCaso: 1000, tokensOutPorCaso: 500, precioInUsdPorM: 1, precioOutUsdPorM: 2,
  usdPen: 4, costoInfraPen: 1000, contactosPorCaso: 2, costoCanalPen: 0.5, pctRespuesta: 50, deudaPromedioPen: 1000, recuperacionIncrementalPp: 2,
};

describe("simulador de escala: costos reproducibles", () => {
  it("aritmética exacta", () => {
    const r = simularEscala(base);
    expect(r.elegibles).toBe(300_000);
    const m = r.masivo, s = r.selectivo;
    // tokens: 300 000 casos × (1000 in, 500 out) → 300 M in y 150 M out → US$ 300 + 300 = 600 → S/ 2 400
    expect(m.casosLlm).toBe(300_000);
    expect(m.costoLlmPen).toBeCloseTo(2400, 6);
    expect(s.casosLlm).toBe(60_000);
    expect(s.costoLlmPen).toBeCloseTo(480, 6);
    expect(m.costoCanalPen).toBe(300_000 * 2 * 0.5);
    expect(m.costoTotalPen).toBeCloseTo(2400 + 300_000 + 1000, 6);
    expect(m.costoPorCuentaPen).toBeCloseTo(m.costoTotalPen / 300_000, 9);
    // beneficio hipotético = elegibles × respuesta × deuda × recuperación
    expect(m.beneficioHipoteticoPen).toBeCloseTo(300_000 * 0.5 * 1000 * 0.02, 6);
    expect(m.roi).toBeCloseTo((m.beneficioHipoteticoPen - m.costoTotalPen) / m.costoTotalPen, 9);
  });
  it("el punto de equilibrio anula el neto", () => {
    const m = simularEscala(base).masivo;
    const r = simularEscala({ ...base, recuperacionIncrementalPp: m.puntoEquilibrioPp! }).masivo;
    expect(r.netoPen).toBeCloseTo(0, 4);
  });
  it("la activación selectiva solo reduce el costo de LLM; canal e infraestructura no cambian", () => {
    const { masivo, selectivo } = simularEscala(base);
    expect(selectivo.costoLlmPen).toBeLessThan(masivo.costoLlmPen);
    expect(selectivo.costoCanalPen).toBe(masivo.costoCanalPen);
    expect(selectivo.costoInfraPen).toBe(masivo.costoInfraPen);
  });
  it("3 y 4 millones escalan linealmente; el resultado es determinístico", () => {
    const a = simularEscala({ ...base, clientes: 3_000_000 }), b = simularEscala({ ...base, clientes: 4_000_000 });
    expect(b.masivo.costoLlmPen / a.masivo.costoLlmPen).toBeCloseTo(4 / 3, 9);
    expect(simularEscala(PARAMS_EJEMPLO)).toEqual(simularEscala(PARAMS_EJEMPLO));
  });
  it("sin recuperación hipotética el neto es negativo (no se garantiza ROI)", () => {
    expect(simularEscala({ ...base, recuperacionIncrementalPp: 0 }).masivo.netoPen).toBeLessThan(0);
  });
  it("rechaza parámetros inválidos", () => {
    expect(validarParams({ ...base, pctLlm: 120 })).toMatch(/pctLlm/);
    expect(validarParams({ ...base, clientes: -1 })).toMatch(/clientes/);
    expect(validarParams({ ...base, usdPen: Number.NaN })).toMatch(/usdPen/);
    expect(() => simularEscala({ ...base, pctElegible: 101 })).toThrow();
  });
});
