"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import TokenAdmin from "@/components/TokenAdmin";
import { adminPost, errorDe } from "@/lib/client";

export default function AdminPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  async function run(accion: "lote" | "cierre" | "reset", etiqueta: string) {
    if (accion === "reset" && !confirm("Se borrarán todas las gestiones, pagos y telemetría y se recargará la cartera de ejemplo. ¿Continuar?")) return;
    setBusy(accion);
    setMsg("");
    try {
      const body = accion === "lote" ? { accion, n: 40 } : accion === "reset" ? { accion, confirmar: "REINICIAR" } : { accion };
      const r = await adminPost("/api/admin", body);
      if (!r.ok) setMsg(`Error: ${await errorDe(r)}`);
      else setMsg(`${etiqueta}: ${JSON.stringify(await r.json())}`);
      router.refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <TokenAdmin />
      <div className="card" style={{ margin: "0 0 16px" }}>
        <h2>Acciones de demo</h2>
        <p className="muted">El lote usa agentes por reglas (sin LLM) para ser rápido y sin costo; para ver al LLM trabajar abre un caso individual. El cierre de mes es una <b>simulación</b>: no concilia pagos reales.</p>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn" disabled={!!busy} onClick={() => run("lote", "Lote")}>{busy === "lote" ? "Procesando…" : "1 · Procesar 40 casos de alto riesgo"}</button>
          <button className="btn" disabled={!!busy} onClick={() => run("cierre", "Cierre de mes")}>{busy === "cierre" ? "Cerrando…" : "2 · Cerrar mes (simulado)"}</button>
          <button className="btn ghost" disabled={!!busy} onClick={() => run("reset", "Reinicio")}>Reiniciar demo</button>
        </div>
        {msg && <p className="note">{msg}</p>}
      </div>
    </>
  );
}
