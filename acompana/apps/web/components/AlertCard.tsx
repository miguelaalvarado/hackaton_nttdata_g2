'use client';
import { useState } from 'react';
import { api, ApiError, fmtDate, SLA_LABEL } from '@/lib/api';
import { ColorBadge, ProfileChip } from './ui';

const ACTIONS: [string, string][] = [
  ['CONTACTO', 'Contacté al becario'],
  ['SESION', 'Realicé una sesión'],
  ['DERIVACION', 'Derivé a otro servicio'],
  ['NOTA', 'Nota de seguimiento'],
  ['CIERRE', 'Cerrar alerta'],
];

function timeLeft(dueAt: string | null, now = Date.now()) {
  if (!dueAt) return '';
  const h = Math.round((new Date(dueAt).getTime() - now) / 3600_000);
  return h >= 0 ? `quedan ${h} h` : `venció hace ${-h} h`;
}

/** Alerta al equipo con registro de acción humana (la primera define el cumplimiento de 48 h). */
export function AlertCard({ a, onChange, showScholar = false }: { a: any; onChange: () => void; showScholar?: boolean }) {
  const [type, setType] = useState('CONTACTO');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const closed = a.status === 'CERRADA';

  async function save() {
    setError(null);
    try {
      await api(`/panel/alerts/${a.id}/actions`, { body: { type, note } });
      setNote('');
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Error');
    }
  }

  return (
    <div className="card" style={{ borderLeft: `4px solid var(--${a.severity === 'ROJO' ? 'rojo' : 'amarillo'})` }}>
      <div className="spread">
        <div className="row">
          <ColorBadge color={a.severity} />
          <ProfileChip profile={a.profile} />
          {showScholar && <strong>{a.scholarName}</strong>}
        </div>
        <span className="small">
          <strong>{SLA_LABEL[a.sla] ?? a.sla}</strong>
          {a.sla === 'EN_PLAZO' && ` · ${timeLeft(a.dueAt)}`}
        </span>
      </div>
      <p className="small" style={{ margin: '8px 0 4px' }}>{a.reason}</p>
      <p className="small" style={{ margin: 0 }}><strong>Acción sugerida:</strong> {a.nextStep}</p>
      <p className="small muted" style={{ margin: '4px 0' }}>
        Responsable: {a.assignee?.name ?? a.assignee ?? 'sin asignar'} · creada {fmtDate(a.createdAt)} ({a.source?.replaceAll('_', ' ').toLowerCase()}) · vence {fmtDate(a.dueAt)}
      </p>
      {a.actions?.length > 0 && Array.isArray(a.actions) && typeof a.actions[0] === 'object' && (
        <div className="timeline small">
          {a.actions.map((x: any) => (
            <div key={x.id}><strong>{x.type}</strong> · {x.actor?.name} · {fmtDate(x.at)}<div>{x.note}</div></div>
          ))}
        </div>
      )}
      {!closed && (
        <div className="row" style={{ marginTop: 6 }}>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input style={{ flex: 1, minWidth: 180 }} placeholder="Qué hiciste y qué sigue" value={note} onChange={(e) => setNote(e.target.value)} />
          <button disabled={note.trim().length < 3} onClick={save}>Registrar</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
