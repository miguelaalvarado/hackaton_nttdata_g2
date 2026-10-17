"use client";

import { useState } from "react";
import type { Channel, ComplianceResult, ContactAttempt, Proposal, TraceStep } from "@/lib/core/types";

type ProposeResponse = {
  proposal: Proposal; trace: TraceStep[]; compliance: ComplianceResult;
  engines: { agent: string; decision: string; customer: string };
};

const TOOL_LABEL: Record<string, string> = {
  get_client_profile: "Consulta el perfil del cliente",
  get_weekly_signals: "Revisa las señales de 12 semanas",
  get_risk_assessment: "Evalúa el riesgo (PD y factores)",
  list_channel_options: "Compara canales por costo vs. pérdida evitada",
  get_contact_history: "Revisa el historial de contactos",
};
const CHANNEL: Record<Channel, string> = {
  push_sms: "Push / SMS", whatsapp: "WhatsApp", email: "Correo", llamada_preventiva: "Llamada preventiva (bot)",
  llamada_asesor: "Llamada de asesor", gestion_avanzada: "Gestión avanzada",
};
const OUTCOME: Record<string, string> = {
  pagara: "Pagará", pide_plazo: "Pide plazo", no_puede_pagar: "No puede pagar", rechaza: "Rechaza", sin_respuesta: "Sin respuesta",
};
const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok && !data.compliance) throw new Error(data.error ?? "Error");
  return data as T;
}

export default function CasePanel({ clientId }: { clientId: string }) {
  const [history, setHistory] = useState<ContactAttempt[]>([]);
  const [current, setCurrent] = useState<ProposeResponse | null>(null);
  const [message, setMessage] = useState("");
  const [compliance, setCompliance] = useState<ComplianceResult | null>(null);
  const [busy, setBusy] = useState<"" | "propose" | "send" | "review">("");
  const [error, setError] = useState("");

  async function propose(h: ContactAttempt[]) {
    setBusy("propose"); setError(""); setCurrent(null);
    try {
      const r = await post<ProposeResponse>("/api/agent/propose", { clientId, history: h });
      setCurrent(r); setMessage(r.proposal.message); setCompliance(r.compliance);
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }

  const edited = current ? { ...current.proposal, message } : null;

  async function review() {
    if (!edited) return;
    setBusy("review");
    try { setCompliance((await post<{ compliance: ComplianceResult }>("/api/agent/respond", { clientId, proposal: edited, history, action: "review" })).compliance); }
    catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }

  async function send() {
    if (!edited) return;
    setBusy("send"); setError("");
    try {
      const r = await post<{ attempt?: ContactAttempt; compliance?: ComplianceResult; error?: string }>("/api/agent/respond", { clientId, proposal: edited, history });
      if (r.compliance && !r.attempt) { setCompliance(r.compliance); setError(r.error ?? "Bloqueado"); return; }
      const next = [...history, r.attempt!];
      setHistory(next);
      if (r.attempt!.outcome !== "pagara") await propose(next); else setCurrent(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }

  const resolved = history.at(-1)?.outcome === "pagara";

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2>Agente de cobranza</h2>

      {history.map((h) => (
        <div key={h.round} className="turn">
          <div className="turn-h">Intento {h.round} · {CHANNEL[h.channel]} · oferta: {h.offer.replace("_", " ")}</div>
          <div className="bubble out">{h.message}</div>
          <div className="bubble in">{h.customer_reply}</div>
          <div className="turn-f"><span className={`chip ${h.outcome === "pagara" ? "bajo" : h.outcome === "pide_plazo" ? "medio" : "alto"}`}>{OUTCOME[h.outcome]}</span></div>
        </div>
      ))}

      {resolved && <p className="ok">Caso resuelto en {history.length} intento(s): el cliente se compromete a pagar.</p>}

      {!current && !resolved && (
        <button className="btn" disabled={!!busy} onClick={() => propose(history)}>
          {busy === "propose" ? "El agente está razonando…" : history.length ? "Replanificar con la respuesta" : "Pedir recomendación al agente"}
        </button>
      )}
      {busy === "propose" && <p className="sub">Consultando herramientas y comparando canales…</p>}
      {error && <p className="err">{error}</p>}

      {current && edited && (
        <>
          <details open className="trace">
            <summary>Razonamiento del agente ({current.trace.filter((s) => s.kind === "tool_call").length} herramientas)</summary>
            <ol>
              {current.trace.filter((s) => s.kind !== "tool_result").map((s, i) => {
                if (s.kind === "note") return <li key={i} className="muted">{s.content}</li>;
                const result = current.trace.find((r) => r.kind === "tool_result" && r.name === s.name);
                return (
                  <li key={i}>
                    <b>{TOOL_LABEL[s.name] ?? s.name}</b>
                    {result && result.kind === "tool_result" && (
                      <details className="muted res"><summary>ver datos</summary>{result.content}</details>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="muted">Motores: agente {current.engines.agent} · decisiones {current.engines.decision} · cliente {current.engines.customer}</p>
          </details>

          <div className="prop">
            <div className="grid2">
              <div><small>Canal</small><b>{CHANNEL[edited.channel]}</b></div>
              <div><small>Oferta</small><b>{edited.offer.replace("_", " ")}</b></div>
              <div><small>Horario</small><b>{edited.send_hour}:00 h</b></div>
              <div><small>Tono</small><b>{edited.tone.replace("_", " ")}</b></div>
            </div>
            <p className="econ">
              Costo {usd(edited.expected_cost)} · pérdida esperada {usd(edited.expected_loss)} · pérdida evitada {usd(edited.expected_loss_avoided)} ·
              <b> valor neto {usd(edited.net_value)}</b>
            </p>
            <p className="why">{edited.rationale}</p>
            <label className="muted" htmlFor="msg">Mensaje (editable)</label>
            <textarea id="msg" value={message} onChange={(e) => setMessage(e.target.value)} onBlur={review} rows={4} />
          </div>

          {compliance && (
            <ul className="checks">
              {compliance.checks.map((c) => (
                <li key={c.id}><span className={`dot ${c.status}`} />{c.label}: <span className="muted">{c.detail}</span></li>
              ))}
            </ul>
          )}

          <div className="row">
            <button className="btn" disabled={!!busy || compliance?.status === "block"} onClick={send}>
              {busy === "send" ? "Enviando…" : "Aprobar y enviar"}
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={() => propose(history)}>Regenerar</button>
          </div>
        </>
      )}
    </div>
  );
}
