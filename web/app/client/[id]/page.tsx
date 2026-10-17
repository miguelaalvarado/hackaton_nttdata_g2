import Link from "next/link";
import { notFound } from "next/navigation";
import { getCtx, modoActual, repos } from "@/lib/container";
import { historialDe } from "@/lib/core/orquestador";
import Visor from "./Visor";

export const dynamic = "force-dynamic";

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { maximumFractionDigits: 0 })}`;

export default async function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await getCtx();
  const c = await repos.cartera.get(id);
  if (!c) notFound();
  const gestiones = await repos.gestiones.porCliente(id);
  const ultima = [...gestiones].reverse().find((g) => g.agente === "gestor" || g.agente === "humano");
  const esperando = !!ultima && ultima.agente === "gestor" && ultima.derivado_humano;

  return (
    <main className="wrap">
      <Link className="back" href="/">← Cartera</Link>
      <h1>
        {c.nombre} <span className="muted">{c.cliente_id}</span>{" "}
        {c.prioridad && <span className={`chip ${c.prioridad === "alta" ? "alto" : c.prioridad === "media" ? "medio" : "bajo"}`}>prioridad {c.prioridad}</span>}{" "}
        <span className={`chip ${c.grupo === "control" ? "medio" : "bajo"}`}>{c.grupo}</span>
      </h1>
      <p className="sub">
        {c.producto} · deuda {money(c.saldo_deuda)} · cuota {money(c.monto_cuota)} · vence {c.fecha_vencimiento} · atraso {c.dias_atraso} d · prefiere {c.canal_preferido} ({c.hora_respuesta} h)
      </p>

      <section className="kpis">
        <div className="card kpi"><b>{c.prob_no_pago !== null ? `${(c.prob_no_pago * 100).toFixed(0)} %` : "—"}</b><span>probabilidad de no pago</span></div>
        <div className="card kpi"><b>{(c.causa_probable ?? "—").replace("_", " ")}</b><span>causa probable (Analista)</span></div>
        <div className="card kpi"><b>{c.sueldo_llego_mes ? "Sí" : "No"}</b><span>sueldo llegó este mes (abono el {c.dia_abono_sueldo})</span></div>
        <div className="card kpi"><b>{money(c.saldo_cuenta)}</b><span>saldo en cuenta · uso de tarjeta {c.uso_linea_tc_pct}% · atrasos 6m: {c.atrasos_ult_6m}</span></div>
      </section>

      <Visor
        clienteId={c.cliente_id}
        gestionesIniciales={gestiones}
        conversacionInicial={historialDe(gestiones)}
        esperandoInicial={esperando}
        modoInicial={modoActual()}
      />
    </main>
  );
}
