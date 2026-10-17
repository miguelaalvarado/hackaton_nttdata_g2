"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function AdminPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  async function run(accion: "lote" | "cierre" | "reset", etiqueta: string, n?: number) {
    if (accion === "reset" && !confirm("Se borrarán todas las gestiones y se recargará la cartera de ejemplo. ¿Continuar?")) return;
    setBusy(accion);
    setMsg("");
    try {
      const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accion, n }) });
      const d = await r.json();
      setMsg(r.ok ? `${etiqueta}: ${JSON.stringify(d)}` : `Error: ${d.error}`);
      router.refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="card" style={{ margin: "0 0 16px" }}>
      <h2>Acciones de demo</h2>
      <p className="muted">El lote usa agentes por reglas (sin LLM) para ser rápido; para ver al LLM trabajar abre un caso individual.</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" disabled={!!busy} onClick={() => run("lote", "Lote", 40)}>{busy === "lote" ? "Procesando…" : "1 · Procesar 40 casos de alto riesgo"}</button>
        <button className="btn" disabled={!!busy} onClick={() => run("cierre", "Cierre de mes")}>{busy === "cierre" ? "Cerrando…" : "2 · Cerrar mes (simulado)"}</button>
        <button className="btn ghost" disabled={!!busy} onClick={() => run("reset", "Reinicio")}>Reiniciar demo</button>
      </div>
      {msg && <p className="note">{msg}</p>}
    </div>
  );
}
