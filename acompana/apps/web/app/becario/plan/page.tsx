'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Card, Loading } from '@/components/ui';

const STATUS: Record<string, string> = { EN_CURSO: 'En curso', APROBADO: 'Aprobado', DESAPROBADO: 'Desaprobado' };
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const KIND: Record<string, string> = { ESTUDIO: 'Estudio', REFUERZO: 'Asesoría', NIVELACION: 'Nivelación' };
const norm = (d: number) => (d === 0 ? 7 : d);
const end = (start: string, minutes: number) => {
  const t = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + minutes;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export default function Plan() {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api('/scholar/plan').then(setD);
  useEffect(() => {
    load();
  }, []);
  if (!d) return <Loading />;

  const plan = d.studyPlan;
  const blocks: any[] = plan?.blocks ?? [];
  const done = blocks.filter((b) => b.doneAt);
  const minutesDone = done.reduce((s, b) => s + b.minutes, 0);
  const minutesPlanned = blocks.reduce((s, b) => s + b.minutes, 0);
  const today = blocks.filter((b) => b.dow === d.todayDow);

  async function toggle(b: any) {
    setError(null);
    try {
      await api(`/scholar/plan/blocks/${b.id}`, { body: { done: !b.doneAt } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo guardar.');
    }
  }

  const BlockRow = ({ b }: { b: any }) => {
    const canMark = norm(b.dow) <= norm(d.todayDow);
    return (
      <div className={`block ${b.kind} ${b.doneAt ? 'done' : ''}`}>
        <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <input type="checkbox" checked={Boolean(b.doneAt)} disabled={!canMark && !b.doneAt} onChange={() => toggle(b)} aria-label={`Marcar ${b.title}`} />
          <span style={{ minWidth: 0 }}>
            <strong className="small">{b.start}–{end(b.start, b.minutes)} · {b.title}</strong>
            <span className={`kind k-${b.kind}`}>{KIND[b.kind]}</span>
            {b.topic && <div className="small">Tema: {b.topic}</div>}
            <div className="small muted">{b.reason}</div>
          </span>
        </label>
      </div>
    );
  };

  return (
    <>
      <h1>Mi plan · semana {d.week.weekNumber}</h1>
      {!plan ? (
        <p className="muted">Completa tu registro inicial para generar tu plan.</p>
      ) : (
        <>
          <Card title="Tu semana en números">
            <div className="spread small">
              <span>Horas de estudio</span>
              <span>{(minutesDone / 60).toFixed(1)} h de {(minutesPlanned / 60).toFixed(1)} h</span>
            </div>
            <div className="bar"><span style={{ width: `${minutesPlanned ? Math.round((minutesDone / minutesPlanned) * 100) : 0}%` }} /></div>
            <p className="small" style={{ marginBottom: 0 }}>
              Asistencia: meta {Math.round((d.goal?.attendanceTarget ?? 0.9) * 100)}% · vas {d.signal ? `${Math.round(d.signal.attendanceRate * 100)}%` : '—'}
            </p>
          </Card>

          <Card title="Hoy">
            {today.length ? today.map((b) => <BlockRow key={b.id} b={b} />) : <p className="small muted" style={{ margin: 0 }}>Hoy no tienes bloques de estudio. Descansa o adelanta algo si te provoca.</p>}
            {error && <p className="error small">{error}</p>}
          </Card>

          <Card title="Por qué tu plan es así">
            {plan.priorities.map((p: any) => (
              <div key={p.courseId} style={{ marginBottom: 8 }}>
                <div className="spread small">
                  <strong>{p.name}</strong>
                  <span><span className={`kind k-${p.level === 'REFUERZO' ? 'REFUERZO' : 'ESTUDIO'}`}>{p.level === 'REFUERZO' ? 'Refuerzo' : 'Mantener'}</span> {(p.minutes / 60).toFixed(1)} h</span>
                </div>
                <div className="small muted">{p.reason}</div>
              </div>
            ))}
            {plan.notes.map((n: string) => <p key={n} className="small notice">{n}</p>)}
          </Card>

          <Card title="Agenda de la semana">
            {[1, 2, 3, 4, 5, 6, 0].map((dow) => {
              const cls = d.classes.filter((c: any) => c.dow === dow);
              const bl = blocks.filter((b) => b.dow === dow);
              if (!cls.length && !bl.length) return null;
              const items = [...cls.map((c: any) => ({ t: c.time, c })), ...bl.map((b) => ({ t: b.start, b }))].sort((a, b) => a.t.localeCompare(b.t));
              return (
                <div key={dow} style={{ marginBottom: 12 }}>
                  <h3 style={{ marginBottom: 6 }}>{DAYS[dow]}{dow === d.todayDow && ' · hoy'}</h3>
                  {items.map((it: any) =>
                    it.c ? (
                      <div key={`c-${it.c.course}-${it.t}`} className="block clase small">
                        <strong>{it.c.time}–{end(it.c.time, 120)} · Clase de {it.c.course}</strong> <span className="muted">({it.c.room})</span>
                      </div>
                    ) : (
                      <BlockRow key={it.b.id} b={it.b} />
                    ),
                  )}
                </div>
              );
            })}
            <p className="small muted" style={{ marginBottom: 0 }}>Marca cada bloque cuando lo termines: así tu equipo y el asistente saben cómo vas. Tu plan nunca cambia tus créditos.</p>
          </Card>
        </>
      )}

      <Card title="Mis cursos">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Curso</th><th>Cr.</th><th>Notas</th><th>Estado</th></tr></thead>
            <tbody>
              {d.courses.map((c: any) => (
                <tr key={c.name}>
                  <td>{c.name}{c.topic && <div className="small muted">{c.topic}</div>}</td>
                  <td>{c.credits}</td>
                  <td>{c.finalGrade ?? (c.partialGrades.length ? c.partialGrades.join(', ') : '—')}</td>
                  <td>{STATUS[c.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Reglas de mi cohorte">
        <p className="small muted" style={{ marginTop: 0 }}>{d.rules.cohort} · {d.rules.legalRef}</p>
        {d.rules.rules.map((r: any) => <p key={r.rule} className="small" style={{ margin: '4px 0' }}>{r.detail}</p>)}
      </Card>
    </>
  );
}
