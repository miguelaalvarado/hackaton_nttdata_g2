'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Card, ErrorBox, Loading } from '@/components/ui';

export default function Onboarding() {
  const router = useRouter();
  const [cfg, setCfg] = useState<any>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ originRegionId: '', livesAlone: false, careerFit: 0, mood: 0, math: [-1, -1, -1, -1, -1], reading: [-1, -1, -1], datos: false, whatsapp: false });
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    api('/scholar/onboarding').then(setCfg);
  }, []);
  if (!cfg) return <Loading />;

  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const scale = (v: number, on: (n: number) => void, labels: [string, string]) => (
    <div>
      <div className="row">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={v === n ? '' : 'secondary'} onClick={() => on(n)} style={{ minWidth: 44 }}>
            {n}
          </button>
        ))}
      </div>
      <div className="spread small muted"><span>{labels[0]}</span><span>{labels[1]}</span></div>
    </div>
  );

  async function submit() {
    setError(null);
    try {
      const r = await api('/scholar/onboarding', {
        body: {
          originRegionId: f.originRegionId,
          livesAlone: f.livesAlone,
          careerFit: f.careerFit,
          mood: f.mood,
          mathAnswers: f.math,
          readingAnswers: f.reading,
          consents: { datos: f.datos, whatsapp: f.whatsapp },
          consentVersions: { datos: cfg.consentTexts.DATOS_LEY_29733.version, whatsapp: cfg.consentTexts.WHATSAPP.version },
        },
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo guardar.');
    }
  }

  if (result) {
    return (
      <Card title="¡Listo! Bienvenido/a 🎉">
        <p>Ya armamos tu kit de llegada y tu plan de la primera semana.</p>
        <p className="small">
          Diagnóstico: matemática {result.mathScore}% · lectura {result.readingScore}%.
          {(result.reinforcement.math || result.reinforcement.reading) && ' Te sumamos sesiones de refuerzo en tu plan para que arranques con todo.'}
        </p>
        <button onClick={() => router.push('/becario')}>Ir a mi inicio</button>
      </Card>
    );
  }

  const steps = [
    {
      title: 'Cuéntanos de ti',
      ok: f.originRegionId && f.careerFit && f.mood,
      body: (
        <>
          <label className="small">¿De qué región vienes?</label>
          <select value={f.originRegionId} onChange={(e) => set({ originRegionId: e.target.value })} style={{ width: '100%', marginBottom: 12 }}>
            <option value="">Elige tu región</option>
            {cfg.regions.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <label className="row small" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={f.livesAlone} onChange={(e) => set({ livesAlone: e.target.checked })} /> Vivo solo/a en la ciudad donde estudio
          </label>
          <p className="small">¿Qué tanto sientes que tu carrera es para ti?</p>
          {scale(f.careerFit, (n) => set({ careerFit: n }), ['Nada', 'Totalmente'])}
          <p className="small">¿Cómo te sientes hoy?</p>
          {scale(f.mood, (n) => set({ mood: n }), ['Muy mal', 'Muy bien'])}
        </>
      ),
    },
    {
      title: 'Diagnóstico corto (5 minutos)',
      ok: !f.math.includes(-1) && !f.reading.includes(-1),
      body: (
        <>
          <p className="small muted">No es un examen: nos ayuda a armar tu plan de refuerzo.</p>
          {cfg.diagnostic.math.map((q: any, i: number) => (
            <Question key={q.id} q={q} value={f.math[i]} onChange={(v) => set({ math: f.math.map((x, j) => (j === i ? v : x)) })} />
          ))}
          {cfg.diagnostic.reading.map((q: any, i: number) => (
            <Question key={q.id} q={q} value={f.reading[i]} onChange={(v) => set({ reading: f.reading.map((x, j) => (j === i ? v : x)) })} />
          ))}
        </>
      ),
    },
    {
      title: 'Tus datos y tus mensajes',
      ok: true,
      body: (
        <>
          <Consent text={cfg.consentTexts.DATOS_LEY_29733.text} version={cfg.consentTexts.DATOS_LEY_29733.version} checked={f.datos} onChange={(v) => set({ datos: v })} label="Acepto el tratamiento de mis datos (obligatorio para usar la plataforma)" />
          <Consent text={cfg.consentTexts.WHATSAPP.text} version={cfg.consentTexts.WHATSAPP.version} checked={f.whatsapp} onChange={(v) => set({ whatsapp: v })} label="Acepto recibir mensajes por WhatsApp (opcional)" />
          <ErrorBox error={error} />
        </>
      ),
    },
  ];
  const s = steps[step];
  return (
    <>
      <p className="small muted">Paso {step + 1} de {steps.length}</p>
      <Card title={s.title}>{s.body}</Card>
      <div className="spread">
        {step > 0 ? <button className="secondary" onClick={() => setStep(step - 1)}>Atrás</button> : <span />}
        {step < steps.length - 1 ? (
          <button disabled={!s.ok} onClick={() => setStep(step + 1)}>Siguiente</button>
        ) : (
          <button onClick={submit}>Terminar</button>
        )}
      </div>
    </>
  );
}

function Question({ q, value, onChange }: { q: any; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {q.text && <p className="small muted" style={{ margin: '0 0 4px' }}>“{q.text}”</p>}
      <strong className="small">{q.q}</strong>
      {q.options.map((o: string, i: number) => (
        <label key={i} className="row small">
          <input type="radio" name={q.id} checked={value === i} onChange={() => onChange(i)} /> {o}
        </label>
      ))}
    </div>
  );
}

function Consent({ text, version, checked, onChange, label }: { text: string; version: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="notice" style={{ marginBottom: 12 }}>
      <p style={{ marginTop: 0 }}>{text}</p>
      <p className="small muted">Versión {version}. Guardamos la fecha y este texto exacto.</p>
      <label className="row"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> <strong className="small">{label}</strong></label>
    </div>
  );
}
