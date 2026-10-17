"use client";

import { useMemo, useState } from "react";
import { COSTO_CANAL_EJEMPLO_PEN, PARAMS_EJEMPLO, simularEscala, type ParamsEscala } from "@/lib/core/escala";

type Obs = {
  llamadas: number; tokensIn: number | null; tokensOut: number | null; casosConLlm: number; cuentasGestionadas: number;
  canales: { canal: string; contactos: number }[];
};

const pen = (n: number) => `S/ ${n.toLocaleString("es-PE", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const num = (n: number) => n.toLocaleString("es-PE", { maximumFractionDigits: 0 });

function Campo({ label, value, onChange, step = "any" }: { label: string; value: number; onChange: (n: number) => void; step?: string }) {
  return (
    <label>{label}
      <input type="number" min={0} step={step} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export default function Economia({ obs }: { obs: Obs }) {
  const promTokIn = obs.casosConLlm && obs.tokensIn != null ? Math.round(obs.tokensIn / obs.casosConLlm) : null;
  const promTokOut = obs.casosConLlm && obs.tokensOut != null ? Math.round(obs.tokensOut / obs.casosConLlm) : null;
  const [p, setP] = useState<ParamsEscala>({ ...PARAMS_EJEMPLO, tokensInPorCaso: promTokIn ?? PARAMS_EJEMPLO.tokensInPorCaso, tokensOutPorCaso: promTokOut ?? PARAMS_EJEMPLO.tokensOutPorCaso });
  const [canal, setCanal] = useState(COSTO_CANAL_EJEMPLO_PEN);
  const set = (k: keyof ParamsEscala) => (n: number) => setP((x) => ({ ...x, [k]: n }));

  // ---- costo OBSERVADO (tokens reales × tarifa SUPUESTA) ----
  const sinUso = obs.llamadas > 0 && obs.tokensIn == null && obs.tokensOut == null;
  const costoLlmObs = obs.tokensIn == null && obs.tokensOut == null ? null : (((obs.tokensIn ?? 0) * p.precioInUsdPorM + (obs.tokensOut ?? 0) * p.precioOutUsdPorM) / 1e6) * p.usdPen;
  const costoCanalObs = obs.canales.reduce((s, c) => s + c.contactos * (canal[c.canal] ?? 0), 0);
  const costoCuenta = obs.cuentasGestionadas ? ((costoLlmObs ?? 0) + costoCanalObs) / obs.cuentasGestionadas : null;

  const r3 = useMemo(() => simularEscala({ ...p, clientes: 3_000_000 }), [p]);
  const r4 = useMemo(() => simularEscala({ ...p, clientes: 4_000_000 }), [p]);
  const rc = useMemo(() => simularEscala(p), [p]);
  const maxCosto = Math.max(rc.masivo.costoTotalPen, rc.selectivo.costoTotalPen, 1);
  const maxLlm = Math.max(rc.masivo.costoLlmPen, 1e-9);

  const fila = (t: string, f: (x: ReturnType<typeof simularEscala>["masivo"]) => string) => (
    <tr><td>{t}</td><td className="num">{f(r3.masivo)}</td><td className="num">{f(r3.selectivo)}</td><td className="num">{f(r4.masivo)}</td><td className="num">{f(r4.selectivo)}</td></tr>
  );

  return (
    <>
      <div className="seccion">
        <span className="etq real">COSTO ESTIMADO DE LO OBSERVADO · tokens reales × tarifa que tú configuras</span>
        <h2>Costo por cuenta gestionada (prototipo)</h2>
        <p className="sub">Los <b>tokens y contactos son reales</b> (tabla <code>llm_calls</code> y <code>gestiones</code>). Las <b>tarifas son supuestos editables</b> (no vienen de ninguna factura).</p>
        <div className="escala">
          <Campo label="USD por 1M tokens de entrada" value={p.precioInUsdPorM} onChange={set("precioInUsdPorM")} step="0.01" />
          <Campo label="USD por 1M tokens de salida" value={p.precioOutUsdPorM} onChange={set("precioOutUsdPorM")} step="0.01" />
          <Campo label="Tipo de cambio (S/ por USD)" value={p.usdPen} onChange={set("usdPen")} step="0.01" />
          {obs.canales.map((c) => <Campo key={c.canal} label={`S/ por contacto · ${c.canal} (${c.contactos} contactos)`} value={canal[c.canal] ?? 0} onChange={(n) => setCanal((x) => ({ ...x, [c.canal]: n }))} step="0.01" />)}
        </div>
        <section className="kpis">
          <div className="card kpi"><b>{obs.llamadas === 0 ? "—" : pen(costoLlmObs ?? 0)}</b><span>{obs.llamadas === 0 ? "sin llamadas reales al LLM" : sinUso ? "tokens: no disponible (el proveedor no informó uso)" : "costo LLM estimado de las llamadas registradas"}</span></div>
          <div className="card kpi"><b>{pen(costoCanalObs)}</b><span>costo de canales estimado (contactos simulados × tarifa supuesta)</span></div>
          <div className="card kpi"><b>{costoCuenta === null ? "—" : pen(costoCuenta)}</b><span>costo por cuenta gestionada ({obs.cuentasGestionadas} cuentas)</span></div>
        </section>
        {sinUso && <p className="note">No disponible: el proveedor no devolvió <code>usage</code>; no se estima ni se inventa.</p>}
      </div>

      <div className="seccion">
        <span className="etq hip">PROYECCIÓN HIPOTÉTICA · supuestos tuyos, no datos del banco</span>
        <h2>Escala a 3 y 4 millones de clientes</h2>
        <p className="sub">Compara <b>procesar todos los casos elegibles con LLM</b> frente a <b>activar el LLM solo donde hace falta</b>. Es aritmética sobre los supuestos de abajo: <b>no es un ROI validado</b>. Los valores iniciales son <b>ejemplos</b> (los tokens se precargan con lo observado si existe).</p>
        <div className="escala">
          <Campo label="% de clientes elegibles (cobranza temprana)" value={p.pctElegible} onChange={set("pctElegible")} />
          <Campo label="% de elegibles que requiere LLM" value={p.pctLlm} onChange={set("pctLlm")} />
          <Campo label={`Tokens de entrada por caso${promTokIn ? " (observado)" : " (ejemplo)"}`} value={p.tokensInPorCaso} onChange={set("tokensInPorCaso")} step="1" />
          <Campo label={`Tokens de salida por caso${promTokOut ? " (observado)" : " (ejemplo)"}`} value={p.tokensOutPorCaso} onChange={set("tokensOutPorCaso")} step="1" />
          <Campo label="Costo de infraestructura del periodo (S/)" value={p.costoInfraPen} onChange={set("costoInfraPen")} step="100" />
          <Campo label="Contactos por caso" value={p.contactosPorCaso} onChange={set("contactosPorCaso")} step="0.1" />
          <Campo label="Costo por contacto (S/)" value={p.costoCanalPen} onChange={set("costoCanalPen")} step="0.01" />
          <Campo label="Tasa de respuesta supuesta (%)" value={p.pctRespuesta} onChange={set("pctRespuesta")} />
          <Campo label="Deuda promedio por caso (S/)" value={p.deudaPromedioPen} onChange={set("deudaPromedioPen")} step="50" />
          <Campo label="Incremento de recuperación HIPOTÉTICO (puntos % de la deuda)" value={p.recuperacionIncrementalPp} onChange={set("recuperacionIncrementalPp")} step="0.01" />
        </div>

        <div className="cmp">
          <div className="card">
            <b>Costo de inferencia (LLM) · cartera de {num(p.clientes)}</b>
            <div className="muted">Masivo: {pen(rc.masivo.costoLlmPen)} · {num(rc.masivo.casosLlm)} casos con LLM</div>
            <div className="barra"><i style={{ width: `${(rc.masivo.costoLlmPen / maxLlm) * 100}%`, background: "var(--high)" }} /></div>
            <div className="muted">Selectivo: {pen(rc.selectivo.costoLlmPen)} · {num(rc.selectivo.casosLlm)} casos con LLM</div>
            <div className="barra"><i style={{ width: `${(rc.selectivo.costoLlmPen / maxLlm) * 100}%`, background: "var(--low)" }} /></div>
          </div>
          <div className="card">
            <b>Costo total (LLM + canales + infraestructura)</b>
            <div className="muted">Masivo: {pen(rc.masivo.costoTotalPen)} ({pen(rc.masivo.costoPorCuentaPen)} por cuenta)</div>
            <div className="barra"><i style={{ width: `${(rc.masivo.costoTotalPen / maxCosto) * 100}%`, background: "var(--high)" }} /></div>
            <div className="muted">Selectivo: {pen(rc.selectivo.costoTotalPen)} ({pen(rc.selectivo.costoPorCuentaPen)} por cuenta)</div>
            <div className="barra"><i style={{ width: `${(rc.selectivo.costoTotalPen / maxCosto) * 100}%`, background: "var(--low)" }} /></div>
          </div>
        </div>

        <div className="card tablewrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Escenario (supuestos arriba)</th><th className="num">3 M · masivo</th><th className="num">3 M · selectivo</th><th className="num">4 M · masivo</th><th className="num">4 M · selectivo</th></tr></thead>
            <tbody>
              <tr><td>Casos elegibles</td><td className="num" colSpan={2}>{num(r3.elegibles)}</td><td className="num" colSpan={2}>{num(r4.elegibles)}</td></tr>
              {fila("Casos con LLM", (x) => num(x.casosLlm))}
              {fila("Tokens de entrada + salida", (x) => num(x.tokensIn + x.tokensOut))}
              {fila("Costo de inferencia", (x) => pen(x.costoLlmPen))}
              {fila("Costo de canales", (x) => pen(x.costoCanalPen))}
              {fila("Costo total", (x) => pen(x.costoTotalPen))}
              {fila("Costo por cuenta", (x) => pen(x.costoPorCuentaPen))}
              {fila("Beneficio HIPOTÉTICO", (x) => pen(x.beneficioHipoteticoPen))}
              {fila("Neto hipotético", (x) => pen(x.netoPen))}
              {fila("ROI hipotético", (x) => (x.roi === null ? "—" : `${(x.roi * 100).toFixed(0)} %`))}
              {fila("Punto de equilibrio (pp de recuperación)", (x) => (x.puntoEquilibrioPp === null ? "—" : x.puntoEquilibrioPp.toFixed(3)))}
            </tbody>
          </table>
        </div>
        <p className="note">
          Lectura: el <b>punto de equilibrio</b> es la recuperación incremental mínima (en puntos porcentuales de la deuda de quienes responden) para que el beneficio iguale el costo; no depende de la hipótesis de recuperación.
          Con estos supuestos el costo de inferencia es {((rc.masivo.costoLlmPen / rc.masivo.costoTotalPen) * 100).toFixed(1)} % del costo total del modelo masivo: el canal y la infraestructura pesan más que los tokens.
          Nada de esto es un resultado bancario validado: la recuperación incremental y la tasa de respuesta son supuestos tuyos.
        </p>
      </div>
    </>
  );
}
