import Link from "next/link";
import { getCtx, repos } from "@/lib/container";

export const dynamic = "force-dynamic";

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { maximumFractionDigits: 0 })}`;
const CHIP = { alta: "alto", media: "medio", baja: "bajo" } as const;

export default async function Cartera({ searchParams }: { searchParams: Promise<{ grupo?: string; prio?: string }> }) {
  const { grupo, prio } = await searchParams;
  await getCtx();
  const todos = await repos.cartera.list();
  const filtrados = todos.filter((c) => (!grupo || c.grupo === grupo) && (!prio || c.prioridad === prio));
  const alta = todos.filter((c) => c.prioridad === "alta");

  const filtro = (label: string, q: Record<string, string>, activo: boolean) => (
    <Link key={label} href={{ pathname: "/", query: q }} className={`pill ${activo ? "on" : ""}`}>{label}</Link>
  );

  return (
    <main className="wrap">
      <h1>Cobranza temprana · cartera priorizada</h1>
      <p className="sub">Cartera sintética de {todos.length} clientes. El Analista ordena por probabilidad de no pago; elige un cliente de <b>tratamiento</b> para ver al Analista, Supervisor, Gestor y asesor humano trabajar en vivo.</p>

      <section className="kpis">
        <div className="card kpi"><b>{todos.length}</b><span>clientes en cartera</span></div>
        <div className="card kpi"><b>{alta.length}</b><span>prioridad alta (prob. ≥ 55 %)</span></div>
        <div className="card kpi"><b>{money(alta.reduce((s, c) => s + c.saldo_deuda, 0))}</b><span>deuda de prioridad alta</span></div>
        <div className="card kpi"><b>{todos.filter((c) => c.grupo === "control").length}</b><span>en grupo control (no se contactan)</span></div>
      </section>

      <div className="filtros">
        {filtro("Todos", {}, !grupo && !prio)}
        {filtro("Prioridad alta", { prio: "alta" }, prio === "alta")}
        {filtro("Tratamiento", { grupo: "tratamiento" }, grupo === "tratamiento")}
        {filtro("Alta + tratamiento", { prio: "alta", grupo: "tratamiento" }, prio === "alta" && grupo === "tratamiento")}
        {filtro("Control", { grupo: "control" }, grupo === "control")}
      </div>

      <div className="card tablewrap">
        <table>
          <thead>
            <tr><th>Cliente</th><th>Producto</th><th>Prob. no pago</th><th>Prioridad</th><th>Causa probable</th><th className="num">Cuota</th><th className="num">Atraso</th><th>Grupo</th><th /></tr>
          </thead>
          <tbody>
            {filtrados.slice(0, 80).map((c) => (
              <tr key={c.cliente_id}>
                <td><b>{c.nombre}</b> <span className="muted">{c.cliente_id}</span></td>
                <td>{c.producto}</td>
                <td>
                  <span className="bar"><i style={{ width: `${(c.prob_no_pago ?? 0) * 100}%` }} /></span>
                  {c.prob_no_pago !== null ? `${(c.prob_no_pago * 100).toFixed(0)} %` : "—"}
                </td>
                <td>{c.prioridad && <span className={`chip ${CHIP[c.prioridad]}`}>{c.prioridad}</span>}</td>
                <td>{(c.causa_probable ?? "").replace("_", " ")}</td>
                <td className="num">{money(c.monto_cuota)}</td>
                <td className="num">{c.dias_atraso} d</td>
                <td>{c.grupo}</td>
                <td><Link href={`/client/${c.cliente_id}`}>Abrir caso →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Se muestran los {Math.min(80, filtrados.length)} primeros de {filtrados.length}. Datos 100 % sintéticos (uso de línea y atrasos anclados a Give Me Some Credit).</p>
    </main>
  );
}
