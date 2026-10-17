"use client";

import { useEffect, useState } from "react";
import { TOKEN_KEY } from "@/lib/client";

/** Cuadro de acceso de administración. Si el servidor no exige token (demo local), no hace falta usarlo. */
export default function TokenAdmin() {
  const [t, setT] = useState("");
  const [guardado, setGuardado] = useState(false);
  useEffect(() => {
    try { setGuardado(!!sessionStorage.getItem(TOKEN_KEY)); } catch { /* sin storage */ }
  }, []);
  return (
    <details className="card acceso">
      <summary>🔐 Acceso de administración {guardado ? <span className="chip bajo">token guardado</span> : <span className="muted">(solo si el servidor lo exige)</span>}</summary>
      <p className="muted">Las acciones que modifican casos, pagos o la base (ciclo, asesor, conciliación, reinicio) requieren el token <code>NEXO_ADMIN_TOKEN</code> del servidor. Se guarda solo en esta pestaña.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); try { sessionStorage.setItem(TOKEN_KEY, t.trim()); setGuardado(true); setT(""); } catch { /* ignora */ } }}>
        <input type="password" autoComplete="off" placeholder="Token de administración" value={t} onChange={(e) => setT(e.target.value)} />
        <button type="submit" className="btn ghost">Guardar</button>
        <button type="button" className="btn ghost" onClick={() => { try { sessionStorage.removeItem(TOKEN_KEY); setGuardado(false); } catch { /* ignora */ } }}>Quitar</button>
      </form>
    </details>
  );
}
