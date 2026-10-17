import Link from "next/link";
import { notFound } from "next/navigation";
import { clients, expectedLoss, getClient, money } from "@/lib/portfolio";
import CasePanel from "./CasePanel";

export function generateStaticParams() {
  return clients.map((c) => ({ id: c.id }));
}

function Spark({ values, max }: { values: number[]; max?: number }) {
  const hi = max ?? Math.max(...values, 1);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${100 - (v / hi) * 90 - 5}`)
    .join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = getClient(id);
  if (!c) notFound();
  const s = c.signals_weekly;
  const minPayWeeks = s.minimum_payment_only.reduce((a, b) => a + b, 0);

  return (
    <main className="wrap">
      <Link className="back" href="/">← Cartera</Link>
      <h1>{c.name} <span className={`chip ${c.risk_band}`}>{c.risk_band}</span></h1>
      <p className="sub">{c.id} · {c.age} años · ingreso mensual {money(c.monthly_income)} · límite {money(c.credit_limit)}</p>

      <section className="kpis">
        <div className="card kpi"><b>{(c.pd * 100).toFixed(1)} %</b><span>probabilidad de mora (modelo)</span></div>
        <div className="card kpi"><b>{money(c.exposure_ead)}</b><span>exposición</span></div>
        <div className="card kpi"><b>{money(expectedLoss(c))}</b><span>pérdida esperada (LGD 60 %)</span></div>
        <div className="card kpi"><b>{minPayWeeks}/{s.minimum_payment_only.length}</b><span>semanas pagando solo el mínimo</span></div>
      </section>

      <div className="grid2">
        <div className="card">
          <h2>Por qué el modelo la ve así</h2>
          {c.reasons.length ? (
            <ul className="list">
              {c.reasons.map((r) => (
                <li key={r.factor}>{r.factor} <span style={{ color: "var(--muted)" }}>(+{r.impact_pp} pp de PD)</span></li>
              ))}
            </ul>
          ) : <p className="sub">Sin factores de riesgo relevantes.</p>}
        </div>
        <div className="card">
          <h2>Señales de las últimas 12 semanas</h2>
          <small>Uso de línea</small><Spark values={s.utilization} max={1.2} />
          <small>Transacciones por semana</small><Spark values={s.transactions_per_week} />
        </div>
      </div>

      <CasePanel clientId={c.id} />
    </main>
  );
}
