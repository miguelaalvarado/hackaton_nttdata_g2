import Link from "next/link";
import { MODELO_METRICAS } from "@/lib/adapters/modelo-logistico";
import { getCtx, repos } from "@/lib/container";
import { P_CUMPLE } from "@/lib/core/seguimiento";
import Economia from "@/components/Economia";
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

  const pr = k.promesas;
  const resueltas = pr.cumplidas + pr.cumplidasSimuladas + pr.rotas;
  const llm = k.llm;
  const tokens = (n: number | null) => (llm.llamadas === 0 ? "—" : n === null ? "No disponible" : n.toLocaleString("es-PE"));
  const totCasos = Math.max(llm.casosConLlm + llm.casosSinLlm, 0);
  const dinero = (n: number) => `S/ ${n.toLocaleString("es-PE", { maximumFractionDigits: 0 })}`;

  return (
    <main className="wrap">
      <Link className="back" href="/">← Cartera</Link>
      <h1>Indicadores, modelo e impacto económico</h1>
      <p className="sub">Tres bloques separados: <b>datos del prototipo</b> (lo que quedó guardado), <b>resultados del simulador</b> (dependen de supuestos de la demo) y <b>proyecciones hipotéticas</b> (aritmética con supuestos tuyos).</p>

      <AdminPanel />

      <div className="seccion">
        <span className="etq real">1 · DATOS DEL PROTOTIPO · observado en SQLite</span>
        <h2>Cartera, gestión y pagos</h2>
        <section className="kpis">
          <div className="card kpi"><b>{k.prioridad.alta} / {k.prioridad.media} / {k.prioridad.baja}</b><span>riesgo alto / medio / bajo (modelo sobre datos sintéticos)</span></div>
          <div className="card kpi"><b>{k.conversaciones}</b><span>casos gestionados (conversación con el Gestor)</span></div>
          <div className="card kpi"><b>{k.gestion.contactosProgramados}</b><span>contactos programados (aún sin ejecutar)</span></div>
          <div className="card kpi"><b>{k.gestion.sinRespuesta}</b><span>casos con falta de respuesta ({k.gestion.reintentos} reintentos programados)</span></div>
          <div className="card kpi"><b>{k.derivados.derivados}</b><span>casos derivados a una persona ({pct(k.derivados.derivados, k.derivados.conversaciones)} de los gestionados)</span></div>
          <div className="card kpi"><b>{pr.pendientes}</b><span>promesas pendientes (una promesa NO es un pago)</span></div>
          <div className="card kpi"><b>{k.pagos.confirmados.n === 0 ? "Ninguno" : `${k.pagos.confirmados.n} · ${dinero(k.pagos.confirmados.monto)}`}</b><span>pagos CONFIRMADOS (eventos de conciliación autorizados){k.pagos.confirmados.n === 0 ? ": no hay recuperación observada" : ""}</span></div>
          <div className="card kpi"><b>{k.pagos.simulados.n} · {dinero(k.pagos.simulados.monto)}</b><span>pagos SIMULADOS por el simulador (no mueven saldo ni son recuperación)</span></div>
        </section>

        <h2>Uso real del LLM</h2>
        <section className="kpis">
          <div className="card kpi"><b>{llm.llamadas}</b><span>llamadas reales al LLM{llm.fallidas ? ` (${llm.fallidas} fallidas)` : ""}</span></div>
          <div className="card kpi"><b>{tokens(llm.tokensIn)} / {tokens(llm.tokensOut)}</b><span>tokens de entrada / salida observados</span></div>
          <div className="card kpi"><b>{llm.latenciaMediaMs === null ? "—" : `${llm.latenciaMediaMs.toFixed(0)} ms`}</b><span>latencia media por llamada</span></div>
          <div className="card kpi"><b>{totCasos ? pct(llm.casosSinLlm, totCasos) : "—"}</b><span>de los casos gestionados se procesaron sin LLM ({llm.casosSinLlm} de {totCasos})</span></div>
        </section>
        {llm.porRol.length > 0 && (
          <div className="card tablewrap"><table>
            <thead><tr><th>Rol</th><th>Modelo</th><th className="num">Llamadas</th><th className="num">Tokens in</th><th className="num">Tokens out</th></tr></thead>
            <tbody>{llm.porRol.map((r) => <tr key={r.rol + r.modelo}><td>{r.rol}</td><td>{r.modelo}</td><td className="num">{r.llamadas}</td><td className="num">{r.tokensIn ?? "No disponible"}</td><td className="num">{r.tokensOut ?? "No disponible"}</td></tr>)}</tbody>
          </table></div>
        )}
        {llm.llamadas === 0 && <p className="note">Sin llamadas al LLM registradas: sin <code>OPENROUTER_API_KEY</code> (o en modo «Reglas») todo corre con reglas y no se inventa ningún consumo.</p>}
      </div>

      <Economia obs={{ llamadas: llm.llamadas, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, casosConLlm: llm.casosConLlm, cuentasGestionadas: k.conversaciones, canales: k.canales }} />

      <div className="seccion">
        <span className="etq sim">2 · RESULTADOS DEL SIMULADOR · dependen de supuestos de la demo</span>
        <h2>Resultado de la estrategia (alta prioridad)</h2>
        <section className="kpis">
          <div className="card kpi"><b>{t ? pct(t.pagan, t.n) : "—"}</b><span>pagan a tiempo (SIMULADO) · tratamiento {t ? `(${t.pagan}/${t.n})` : ""}</span></div>
          <div className="card kpi"><b>{c ? pct(c.pagan, c.n) : "—"}</b><span>pagan a tiempo (SIMULADO) · control {c ? `(${c.pagan}/${c.n})` : ""}</span></div>
          <div className="card kpi"><b>{k.liftPp === null ? "—" : `${k.liftPp >= 0 ? "+" : ""}${k.liftPp.toFixed(1)} pp`}</b><span>lift de pago a tiempo SIMULADO (tratamiento − control)</span></div>
          <div className="card kpi"><b>{pct(pr.cumplidas + pr.cumplidasSimuladas, resueltas)}</b><span>promesas cumplidas: {pr.cumplidas} con pago confirmado + {pr.cumplidasSimuladas} simuladas, de {resueltas} resueltas ({pr.canceladas} canceladas)</span></div>
        </section>
        <p className="note">
          Supuestos del simulador: una promesa «se cumple» con probabilidad {P_CUMPLE.motivoAcertado * 100} % si el Gestor identificó el motivo real del cliente y {P_CUMPLE.motivoErrado * 100} % si no, y entonces el simulador genera un <b>pago simulado</b>;
          sin promesa cumplida, el cliente paga según su comportamiento base. Estas cifras miden el efecto de ESE simulador, <b>no recuperaciones observadas</b>; solo los pagos confirmados lo serían. La comparación es por intención de tratar (todos los de tratamiento de alta prioridad frente a todos los de control).
        </p>
        {k.liftPp === null && <p className="note">Para ver el lift: procesa un lote y pulsa «Cerrar mes (simulado)».</p>}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Motivos de no pago más frecuentes</h2>
          {k.motivos.length === 0 && <p className="muted">Aún no hay conversaciones.</p>}
          {k.motivos.map((x) => (
            <div key={x.motivo} className="hbar">
              <span>{x.motivo.replace(/_/g, " ")}</span>
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
