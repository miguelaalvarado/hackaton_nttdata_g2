'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, getSession, PROFILE_LABEL } from '@/lib/api';
import { AlertCard } from '@/components/AlertCard';
import { Chat } from '@/components/Chat';
import { Card, ColorBadge, Loading, ProfileChip } from '@/components/ui';

const RULE_ICON: Record<string, string> = { CUMPLE: '✅', EN_RIESGO: '⚠️', INCUMPLE: '⛔', NO_APLICA: '➖', SIN_DATOS: '⏳' };

export default function ScholarDetail() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<any>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ kind: string; templateName: string; text: string }>({ kind: 'TEMPLATE', templateName: 'checkin_semanal', text: '' });
  const [sendResult, setSendResult] = useState<any>(null);
  const role = getSession()?.user.role;

  const load = () => api(`/panel/scholars/${id}`).then(setD);
  useEffect(() => {
    load();
    api('/panel/templates').then(setTemplates);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <Loading />;

  const risk = d.risks.at(-1);
  const prof = d.profiles.at(-1);
  const teamAlerts = d.alerts.filter((a: any) => a.direction === 'TEAM');
  const scholarAlert = d.alerts.find((a: any) => a.direction === 'SCHOLAR' && a.status !== 'CERRADA');
  const first = d.name.split(' ')[0];

  async function send() {
    const tpl = templates.find((t) => t.name === msg.templateName);
    const params = msg.kind === 'TEMPLATE' ? paramsFor(tpl?.name, first, d) : undefined;
    setSendResult(await api(`/panel/scholars/${id}/message`, { body: { kind: msg.kind, templateName: msg.templateName, params, text: msg.text } }));
    load();
  }

  return (
    <>
      <div className="spread">
        <div>
          <h1>{d.name} {risk && <ColorBadge color={risk.color} />}</h1>
          <p className="small muted" style={{ marginTop: 0 }}>
            {d.career} · {d.university} · De {d.origin}{d.livesAlone ? ', vive solo/a' : ''} · Cohorte: {d.cohort.name}
            {d.mentor && <> · Mentor: {d.mentor.name} ({d.mentor.reason.toLowerCase()})</>}
          </p>
          {d.persona && <p className="small notice">{d.persona}</p>}
        </div>
        {role !== 'MENTOR' && <button className="secondary" onClick={async () => { await api(`/panel/scholars/${id}/recalculate`, { body: {} }); load(); }}>Recalcular ahora</button>}
      </div>

      <div className="grid g2">
        <Card title="¿Por qué este color? (3 razones principales)">
          {risk ? (
            <>
              <ol className="reasons">
                {risk.reasons.map((r: any) => (
                  <li key={r.code}>
                    {r.text} <span className="small muted">({r.source === 'REGLA' ? 'regla' : r.direction === 'SUBE' ? 'modelo: sube el riesgo' : 'modelo: factor a favor'})</span>
                  </li>
                ))}
              </ol>
              <p className="small muted">Probabilidad estimada: {Math.round(risk.probability * 100)}% · semana {risk.weekStart}. No usa origen, lengua ni pobreza.</p>
              <div className="row small">
                Historia: {d.risks.map((r: any) => <ColorBadge key={r.weekStart} color={r.color} />)}
              </div>
            </>
          ) : <p className="muted">Sin datos aún.</p>}
        </Card>

        <Card title="Perfiles de la semana">
          {prof ? (
            <>
              <div>{prof.profiles.map((p: string) => <ProfileChip key={p} profile={p} />)}</div>
              <ul className="small">
                {Object.entries(prof.evidence).map(([p, ev]: any) => <li key={p}><strong>{PROFILE_LABEL[p]}:</strong> {ev.join('; ')}</li>)}
              </ul>
              {scholarAlert && <p className="small"><strong>Lo que ve el becario:</strong> {scholarAlert.nextStep}</p>}
            </>
          ) : <p className="muted">Sin datos aún.</p>}
        </Card>
      </div>

      <h2>Alertas al equipo</h2>
      {teamAlerts.length === 0 && <p className="muted">Sin alertas.</p>}
      {teamAlerts.map((a: any) => <AlertCard key={a.id} a={a} onChange={load} />)}

      <div className="grid g2">
        <Card title="Reglas de su cohorte">
          <p className="small muted" style={{ marginTop: 0 }}>{d.rules.legalRef}</p>
          {d.rules.rules.map((r: any) => <p key={r.rule} className="small" style={{ margin: '4px 0' }}>{RULE_ICON[r.status]} {r.detail}</p>)}
        </Card>
        <Card title="Señales por semana">
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>Sem.</th><th>Asist.</th><th>Días activo</th><th>Horas</th><th>Parciales</th><th>Desapr.</th><th>Ánimo</th></tr></thead>
              <tbody>
                {d.signals.map((s: any) => (
                  <tr key={s.weekStart}>
                    <td>{s.weekNumber}</td><td>{Math.round(s.attendanceRate * 100)}%</td><td>{s.activeDays}</td>
                    <td>{s.studyHours}/{s.studyHoursTarget}</td><td>{s.avgPartial ?? '—'}</td><td>{s.failedAttempts}</td><td>{s.mood ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.checklist.overdue.length > 0 && <p className="small">Kit vencido: {d.checklist.overdue.join('; ')}</p>}
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Conversación (simulador de WhatsApp)">
          <Chat scholarId={id} canWrite={false} teamView />
        </Card>
        <Card title="Enviar mensaje">
          <p className="small muted" style={{ marginTop: 0 }}>Todo envío pasa por las reglas: opt-in, BAJA, ventana de 24 h, tope diario y silencio 22:00–07:00.</p>
          <div className="row">
            <select value={msg.kind} onChange={(e) => setMsg({ ...msg, kind: e.target.value })}>
              <option value="TEMPLATE">Plantilla (plataforma)</option>
              <option value="FREE">Texto libre (persona del equipo)</option>
            </select>
            {msg.kind === 'TEMPLATE' ? (
              <select value={msg.templateName} onChange={(e) => setMsg({ ...msg, templateName: e.target.value })}>
                {templates.map((t) => <option key={t.name} value={t.name}>{t.name} · {t.category}</option>)}
              </select>
            ) : (
              <input style={{ flex: 1 }} value={msg.text} onChange={(e) => setMsg({ ...msg, text: e.target.value })} placeholder="Mensaje" />
            )}
            <button onClick={send}>Enviar</button>
          </div>
          {sendResult && (
            <p className={sendResult.status === 'ENVIADO' ? 'ok small' : 'error small'}>
              {sendResult.status === 'ENVIADO' ? 'Enviado.' : sendResult.status === 'BLOQUEADO' ? `Bloqueado: ${sendResult.policyDecision}` : `Diferido (${sendResult.policyDecision}) hasta ${new Date(sendResult.scheduledFor).toLocaleString('es-PE', { timeZone: 'America/Lima' })}`}
            </p>
          )}
          <h3 style={{ marginTop: 14 }}>Consentimientos</h3>
          {d.consents.map((c: any, i: number) => (
            <p key={i} className="small" style={{ margin: '3px 0' }}>
              {c.type} · {c.textVersion} · aceptado {new Date(c.acceptedAt).toLocaleDateString('es-PE')} ({c.channel}){c.revokedAt && ` · revocado ${new Date(c.revokedAt).toLocaleDateString('es-PE')}`}
            </p>
          ))}
        </Card>
      </div>
    </>
  );
}

function paramsFor(name: string | undefined, first: string, d: any): string[] {
  switch (name) {
    case 'recordatorio_clase':
      return [first, 'tu próxima clase', '08:00', 'tu aula'];
    case 'vencimiento_tramite':
      return [first, d.checklist.overdue[0] ?? 'Revisar fecha de depósito', 'esta semana', 'Revísalo en tu kit de llegada'];
    case 'cita_programada':
      return [first, 'Tu tutor', 'mañana'];
    case 'pastilla_semana':
      return [first, 'un tema nuevo', d.career, 'Cada semana que avanzas cuenta.'];
    default:
      return [first];
  }
}
