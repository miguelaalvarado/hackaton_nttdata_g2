'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Card, Loading } from '@/components/ui';

const RULE_LABEL: Record<string, string> = { PROMEDIO: 'Promedio ponderado', CREDITOS: 'Créditos matriculados', TERCIO_SUPERIOR: 'Tercio superior', DESAPROBADOS: 'Cursos desaprobados' };
const STATUS_ICON: Record<string, string> = { CUMPLE: '✅', EN_RIESGO: '⚠️', INCUMPLE: '⛔', NO_APLICA: '➖', SIN_DATOS: '⏳' };

export default function Home() {
  const router = useRouter();
  const [d, setD] = useState<any>(null);
  const [lifeEvent, setLifeEvent] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    api('/scholar/home').then((h) => {
      if (!h.onboardingDone) router.replace('/becario/onboarding');
      else setD(h);
    });
  }, [router]);
  if (!d) return <Loading />;

  const sig = d.signals;
  const goal = d.goal;
  return (
    <>
      <h1>Hola, {d.firstName} 👋</h1>
      <p className="muted small">
        {d.career} · {d.university} · Semana {d.week.weekNumber} del ciclo
      </p>

      {d.nextStep ? (
        <Card title="Tu siguiente paso">
          <p style={{ margin: 0 }}>{d.nextStep.text}</p>
          <p className="small muted">Lo vemos juntos: si necesitas ayuda, escríbeme en WhatsApp.</p>
        </Card>
      ) : (
        <Card title="Vas muy bien esta semana">
          <p style={{ margin: 0 }}>Sigue con tu plan. Si algo cambia, cuéntamelo por WhatsApp.</p>
        </Card>
      )}

      {sig && goal && (
        <Card title="Tu semana">
          <Progress label="Asistencia" value={sig.attendanceRate} target={goal.attendanceTarget} fmt={(v) => `${Math.round(v * 100)}%`} />
          <Progress label="Horas de estudio" value={sig.studyHours} target={goal.studyHoursTarget} fmt={(v) => `${v} h`} />
          <Link href="/becario/plan" className="small">Ver mi plan →</Link>
        </Card>
      )}

      {d.rules && (
        <Card title={`Cómo vas frente a las reglas de tu cohorte`}>
          <p className="small muted" style={{ marginTop: 0 }}>{d.rules.cohort}</p>
          {d.rules.rules.map((r: any) => (
            <div key={r.rule} style={{ marginBottom: 8 }}>
              <strong>{STATUS_ICON[r.status]} {RULE_LABEL[r.rule]}</strong>
              <div className="small">{r.detail}</div>
            </div>
          ))}
        </Card>
      )}

      <Card title="Kit de llegada">
        <p style={{ margin: 0 }}>
          {d.checklist.done} de {d.checklist.total} pendientes resueltos. <Link href="/becario/kit">Revisar</Link>
        </p>
      </Card>

      {d.mentor && (
        <Card title="Tu mentor par">
          <p style={{ margin: 0 }}>
            {d.mentor.name} <span className="small muted">({d.mentor.reason.toLowerCase()})</span>
          </p>
        </Card>
      )}

      <Card title="¿Pasó algo importante?">
        <p className="small muted" style={{ marginTop: 0 }}>Un duelo, un problema de salud o de familia. Solo lo verá tu equipo de acompañamiento.</p>
        {sent ? (
          <p className="ok">Gracias por contarnos. Tu coordinador te escribirá para ver opciones juntos.</p>
        ) : (
          <>
            <textarea rows={2} value={lifeEvent} onChange={(e) => setLifeEvent(e.target.value)} placeholder="Cuéntanos en pocas palabras" />
            <button disabled={!lifeEvent.trim()} onClick={async () => { await api('/scholar/life-event', { body: { note: lifeEvent } }); setSent(true); }}>
              Avisar a mi equipo
            </button>
          </>
        )}
      </Card>

      <Card title="Mis consentimientos">
        {d.consents.map((c: any) => (
          <div key={c.type} className="small">
            ✔ {c.type === 'DATOS_LEY_29733' ? 'Tratamiento de datos (Ley 29733)' : c.type === 'WHATSAPP' ? 'Mensajes por WhatsApp' : 'Puente con mi familia'} · {new Date(c.acceptedAt).toLocaleDateString('es-PE')} · {c.textVersion}
          </div>
        ))}
        {!d.consents.some((c: any) => c.type === 'WHATSAPP') && <p className="small">No recibes mensajes por WhatsApp. Puedes activarlos escribiendo ALTA.</p>}
      </Card>
    </>
  );
}

function Progress({ label, value, target, fmt }: { label: string; value: number; target: number; fmt: (v: number) => string }) {
  const pct = Math.min(100, Math.round((value / target) * 100));
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="spread small">
        <span>{label}</span>
        <span>
          {fmt(value)} / meta {fmt(target)}
        </span>
      </div>
      <div className="bar"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
