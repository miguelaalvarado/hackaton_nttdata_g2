import Link from "next/link";
import { MODELO_METRICAS } from "@/lib/adapters/modelo-logistico";
import { getCtx, repos } from "@/lib/container";
import { P_CUMPLE } from "@/lib/core/seguimiento";
import AdminPanel from "./AdminPanel";

export const dynamic = "force-dynamic";

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)} %` : "—");

export default async function Dashboard() {
  await getCtx();
  const k = await repos.kpis.kpis();
  const t = k.pagoAltoRiesgo.find((x) => x.grupo === "tratamiento");
  const c = k.pagoAltoRiesgo.find((x) => x.grupo === "control");
  const m = MODELO_METRICAS;
  const maxMotivo = Math.max(1, ...k.motivos.map((x) => x.n));

  return (
    <main className="wrap">
      <Link className="back" href="/">← Cartera</Link>
      <h1>Indicadores y modelo</h1>
      <p className="sub">Calculados con consultas SQL sobre <code>cartera</code> y <code>gestiones</code>. Los pagos y el cumplimiento de promesas son <b>simulados</b>: miden el efecto del simulador, no resultados reales.</p>

      <AdminPanel />

      <h2>Resultado de la estrategia (alta prioridad)</h2>
      <section className="kpis">
        <div className="card kpi"><b>{t ? pct(t.pagan, t.n) : "—"}</b><span>pagan a tiempo · tratamiento {t ? `(${t.pagan}/${t.n})` : ""}</span></div>
        <div className="card kpi"><b>{c ? pct(c.pagan, c.n) : "—"}</b><span>pagan a tiempo · control {c ? `(${c.pagan}/${c.n})` : ""}</span></div>
        <div className="card kpi"><b>{k.liftPp === null ? "—" : `${k.liftPp >= 0 ? "+" : ""}${k.liftPp.toFixed(1)} pp`}</b><span>lift de pago a tiempo (tratamiento − control)</span></div>
        <div className="card kpi"><b>{pct(k.promesas.cumplidas, k.promesas.cumplidas + k.promesas.rotas)}</b><span>promesas cumplidas ({k.promesas.cumplidas} de {k.promesas.cumplidas + k.promesas.rotas} resueltas; {k.promesas.pendientes} pendientes)</span></div>
        <div className="card kpi"><b>{pct(k.derivados.derivados, k.derivados.conversaciones)}</b><span>casos derivados a un humano ({k.derivados.derivados} de {k.derivados.conversaciones})</span></div>
      </section>
      <p className="note">
        Supuestos del simulador: una promesa se cumple con probabilidad {P_CUMPLE.motivoAcertado * 100} % si el Gestor identificó el motivo real del cliente y {P_CUMPLE.motivoErrado * 100} % si no;
        sin promesa cumplida, el cliente paga según su comportamiento base. La comparación es por intención de tratar (todos los de tratamiento de alta prioridad frente a todos los de control), no solo los contactados.
      </p>
      {k.liftPp === null && <p className="note">Para ver el lift: procesa un lote y pulsa «Cerrar mes» (la medición necesita casos de tratamiento y de control resueltos).</p>}

      <div className="grid2">
        <div className="card">
          <h2>Motivos de no pago más frecuentes</h2>
          {k.motivos.length === 0 && <p className="muted">Aún no hay conversaciones.</p>}
          {k.motivos.map((x) => (
            <div key={x.motivo} className="hbar">
              <span>{x.motivo.replace("_", " ")}</span>
              <i style={{ width: `${(x.n / maxMotivo) * 100}%` }} />
              <b>{x.n}</b>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Modelo de probabilidad de no pago</h2>
          <p className="muted">{m.origen}</p>
          <table>
            <tbody>
              <tr><td>AUC del modelo (regresión logística)</td><td className="num"><b>{m.auc_modelo}</b></td></tr>
              <tr><td>AUC de la regla de puntos del documento</td><td className="num">{m.auc_regla_docx}</td></tr>
              <tr><td>KS</td><td className="num">{m.ks_modelo}</td></tr>
              <tr><td>Precisión en el 20 % de mayor riesgo</td><td className="num">{(m.precision_top20 * 100).toFixed(0)} %</td></tr>
              <tr><td>Lift en el 20 % de mayor riesgo</td><td className="num">{m.lift_top20}×</td></tr>
              <tr><td>Tasa base de no pago</td><td className="num">{(m.tasa_no_pago * 100).toFixed(0)} %</td></tr>
            </tbody>
          </table>
          <p className="note">Evaluado en {m.n_test} clientes de prueba (de {m.n_total}). Como los patrones se plantaron a propósito, el modelo solo demuestra que recupera esos patrones con ruido.</p>
        </div>
      </div>
    </main>
  );
}
