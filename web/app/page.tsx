import Link from "next/link";
import { clients, expectedLoss, meta, money } from "@/lib/portfolio";

export default function Portfolio() {
  const high = clients.filter((c) => c.risk_band === "alto");
  const exposureHigh = high.reduce((s, c) => s + c.exposure_ead, 0);
  const lossTotal = clients.reduce((s, c) => s + expectedLoss(c), 0);

  return (
    <main className="wrap">
      <h1>Cobrador · cobranza temprana</h1>
      <p className="sub">Cartera demo ordenada por probabilidad de mora (PD). Elige un cliente para que el agente proponga el contacto.</p>

      <section className="kpis">
        <div className="card kpi"><b>{clients.length}</b><span>clientes en la cartera demo</span></div>
        <div className="card kpi"><b>{high.length}</b><span>en riesgo alto (PD ≥ 30 %)</span></div>
        <div className="card kpi"><b>{money(exposureHigh)}</b><span>exposición en riesgo alto</span></div>
        <div className="card kpi"><b>{money(lossTotal)}</b><span>pérdida esperada (LGD 60 %, supuesto)</span></div>
      </section>

      <div className="card tablewrap">
        <table>
          <thead>
            <tr>
              <th>Cliente</th><th>Riesgo</th><th>PD</th>
              <th className="num">Exposición</th><th className="num">Pérdida esp.</th>
              <th className="num">Uso de línea</th><th className="num">Atrasos 30+/60+/90+</th><th />
            </tr>
          </thead>
          <tbody>
            {clients.slice(0, 60).map((c) => {
              const util = c.signals_weekly.utilization.at(-1) ?? 0;
              return (
                <tr key={c.id}>
                  <td><b>{c.name}</b> <span style={{ color: "var(--muted)" }}>{c.id}</span></td>
                  <td><span className={`chip ${c.risk_band}`}>{c.risk_band}</span></td>
                  <td>
                    <span className="bar"><i style={{ width: `${Math.min(100, c.pd * 100)}%` }} /></span>
                    {(c.pd * 100).toFixed(1)} %
                  </td>
                  <td className="num">{money(c.exposure_ead)}</td>
                  <td className="num">{money(expectedLoss(c))}</td>
                  <td className="num">{(util * 100).toFixed(0)} %</td>
                  <td className="num">{c.late_30_59} / {c.late_60_89} / {c.late_90_plus}</td>
                  <td><Link href={`/client/${c.id}`}>Abrir caso →</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="note">
        Se muestran los 60 clientes de mayor PD. Real: PD, razones y variables de crédito ({meta.source}; {meta.model}).
        Sintético: nombres, límite de línea, exposición y series semanales.
      </p>
    </main>
  );
}
