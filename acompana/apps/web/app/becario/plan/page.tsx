'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, Loading } from '@/components/ui';

const STATUS: Record<string, string> = { EN_CURSO: 'En curso', APROBADO: 'Aprobado', DESAPROBADO: 'Desaprobado' };

export default function Plan() {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api('/scholar/plan').then(setD); }, []);
  if (!d) return <Loading />;
  const goals = (d.goal?.courseGoals ?? []) as any[];
  return (
    <>
      <h1>Mi plan · semana {d.week.weekNumber}</h1>
      <Card title="Metas de la semana">
        <p className="small" style={{ marginTop: 0 }}>
          Asistencia: meta {Math.round((d.goal?.attendanceTarget ?? 0.9) * 100)}% · vas {d.signal ? Math.round(d.signal.attendanceRate * 100) : '—'}%
          <br />
          Horas de estudio: meta {d.goal?.studyHoursTarget ?? '—'} h · vas {d.signal?.studyHours ?? 0} h
        </p>
        {goals.map((g) => (
          <div key={g.courseId} style={{ marginBottom: 10 }}>
            <div className="spread small">
              <strong>{g.name}{g.reinforcement && ' · refuerzo'}</strong>
              <span>{g.done} / {g.target} h</span>
            </div>
            {g.topic && <div className="small muted">Tema: {g.topic}</div>}
            <div className="bar"><span style={{ width: `${Math.min(100, Math.round((g.done / g.target) * 100))}%` }} /></div>
          </div>
        ))}
        {goals.some((g) => g.reinforcement) && <p className="small muted">“Refuerzo” = te sumamos asesoría o nivelación en ese curso para que vayas más seguro/a.</p>}
      </Card>
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
