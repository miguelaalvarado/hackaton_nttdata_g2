import Link from "next/link";
import { notFound } from "next/navigation";
import { getCtx, llmDisponible, modoActual, repos } from "@/lib/container";
import { estadoCaso } from "@/lib/core/estado";
import { historialDe } from "@/lib/core/orquestador";
import { motivosBloqueo, reglasDe } from "@/lib/core/reglas";
import Visor from "./Visor";

export const dynamic = "force-dynamic";

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { maximumFractionDigits: 0 })}`;

export default async function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await getCtx();
  const c = await repos.cartera.get(id);
  if (!c) notFound();
  const gestiones = await repos.gestiones.porCliente(id);
  const reglas = await repos.reglas.todas();
  const estado = estadoCaso(gestiones, motivosBloqueo(reglas));
  const pagos = await repos.pagos.porCliente(id);
  const opciones = reglasDe(reglas, "opcion_pago").map((r) => r.valor + (r.condicion !== "siempre" ? ` (${r.condicion})` : ""));

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
        resumen={{ nombre: c.nombre, deuda: c.saldo_deuda, cuota: c.monto_cuota, atraso: c.dias_atraso, canal: c.canal_preferido }}
        gestionesIniciales={gestiones}
        conversacionInicial={historialDe(gestiones)}
        estadoInicial={estado}
        pagosIniciales={pagos}
        modoInicial={modoActual()}
        llmDisponible={llmDisponible()}
        opciones={opciones}
      />
    </main>
  );
}
