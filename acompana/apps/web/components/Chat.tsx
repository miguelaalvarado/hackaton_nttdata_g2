'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtDate } from '@/lib/api';

const POLICY_LABEL: Record<string, string> = {
  SIN_OPT_IN: 'Bloqueado: sin opt-in',
  BAJA_SOLICITADA: 'Bloqueado: el becario pidió BAJA',
  FUERA_DE_VENTANA_REQUIERE_PLANTILLA: 'Bloqueado: fuera de la ventana de 24 h (requiere plantilla)',
  PLANTILLA_NO_EXISTE: 'Bloqueado: plantilla inexistente',
  PLANTILLA_NO_APROBADA: 'Bloqueado: plantilla no aprobada',
  HORARIO_SILENCIO: 'Diferido: horario de silencio (22:00–07:00 Lima)',
  TOPE_DIARIO: 'Diferido: tope diario de mensajes de la plataforma',
};
const INITIATOR: Record<string, string> = { PLATFORM: 'Plataforma', REPLY: 'Asistente', HUMAN: 'Equipo', SAFETY: 'Seguridad', OPT_OUT_CONFIRMATION: 'Confirmación de baja', SCHOLAR: 'Becario' };

/** Chat del simulador de WhatsApp. El becario escribe; el equipo ve además las decisiones de política. */
export function Chat({ scholarId, canWrite, teamView = false }: { scholarId: string; canWrite: boolean; teamView?: boolean }) {
  const [d, setD] = useState<any>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = () => api(`/chat/${scholarId}`).then(setD);
  useEffect(() => {
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scholarId]);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [d?.messages?.length]);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/chat/${scholarId}/inbound`, { body: { text } });
      setText('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <p className="muted">Cargando chat…</p>;
  return (
    <div className={teamView ? 'panel-chat' : ''}>
      <div className="row small" style={{ marginBottom: 6 }}>
        <span className="notice">{d.state.optedOutAt ? '⛔ De baja (BAJA)' : d.state.optIn ? '✔ Opt-in vigente' : '✖ Sin opt-in'}</span>
        <span className="notice">
          Ventana 24 h: {d.state.windowOpen ? `abierta hasta ${fmtDate(d.state.windowClosesAt)}` : 'cerrada (solo plantillas)'}
        </span>
        {teamView && <span className="notice">Asistente: {d.provider}</span>}
      </div>
      <div className="chat" ref={box}>
        {d.messages.length === 0 && <p className="small muted">Aún no hay mensajes. {canWrite && 'Escribe “hola” para empezar.'}</p>}
        {d.messages.map((m: any) => (
          <div key={m.id} className={`msg ${m.direction} ${m.status}`}>
            {m.body}
            <div className="meta">
              {teamView && `${INITIATOR[m.initiator] ?? m.initiator}${m.templateName ? ` · plantilla ${m.templateName} (${m.category})` : ''} · `}
              {fmtDate(m.createdAt)}
              {m.direction === 'OUT' && ` · ${m.status.toLowerCase()}`}
              {teamView && m.policyDecision && m.policyDecision !== 'ALLOW' && <div>{POLICY_LABEL[m.policyDecision] ?? m.policyDecision}{m.scheduledFor && ` → ${fmtDate(m.scheduledFor)}`}</div>}
              {teamView && m.errorCode && <div>Error: {m.errorCode}</div>}
            </div>
          </div>
        ))}
      </div>
      {canWrite && (
        <div className="composer">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Escribe un mensaje" disabled={busy} />
          <button onClick={send} disabled={busy || !text.trim()}>Enviar</button>
        </div>
      )}
    </div>
  );
}
