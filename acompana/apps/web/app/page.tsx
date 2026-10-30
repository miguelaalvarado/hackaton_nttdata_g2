'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, setSession } from '@/lib/api';

interface DemoAccount {
  dni: string;
  name: string;
  role: string;
  specialty: string | null;
  university: string;
  persona: string | null;
}

const ROLE_LABEL: Record<string, string> = { BECARIO: 'Becario/a', MENTOR: 'Mentor par', TUTOR: 'Tutoría / psicología', COORDINADOR: 'Coordinación' };
const DEMO_PASSWORD = 'Acompana2026';

export default function Login() {
  const router = useRouter();
  const [dni, setDni] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);

  useEffect(() => {
    api<DemoAccount[]>('/auth/demo-users').then(setAccounts).catch(() => setAccounts([]));
  }, []);

  async function submit(e?: FormEvent, override?: { dni: string; password: string }) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const s = await api('/auth/login', { body: override ?? { dni, password } });
      setSession(s);
      router.push(s.user.role === 'BECARIO' ? '/becario' : '/panel');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar. Intenta de nuevo en unos minutos.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 920 }}>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <section>
          <h1 className="brand">Acompaña</h1>
          <p className="muted">Tu acompañamiento en el primer ciclo de Beca 18: tu plan de estudio, tus trámites y alguien que te escucha.</p>
          <form className="card" onSubmit={submit} noValidate>
            <h2 style={{ marginTop: 0 }}>Ingresa</h2>
            <label htmlFor="dni" className="small">DNI</label>
            <input
              id="dni"
              inputMode="numeric"
              autoComplete="username"
              maxLength={8}
              placeholder="8 dígitos"
              value={dni}
              onChange={(e) => setDni(e.target.value.replace(/\D/g, ''))}
              style={{ width: '100%', marginBottom: 10 }}
            />
            <label htmlFor="password" className="small">Contraseña</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', marginBottom: 12 }} />
            {error && <p className="error small">{error}</p>}
            <button type="submit" disabled={busy || dni.length !== 8 || !password} style={{ width: '100%' }}>
              {busy ? 'Ingresando…' : 'Ingresar'}
            </button>
            <p className="small muted" style={{ marginBottom: 0 }}>
              ¿Olvidaste tu contraseña? Pide a tu coordinador que la restablezca. Tras 5 intentos fallidos el ingreso se bloquea 15 minutos.
            </p>
          </form>
        </section>

        {accounts.length > 0 && (
          <section>
            <h2>Cuentas de prueba</h2>
            <p className="small muted">
              Datos ficticios. Contraseña de todas las cuentas: <strong>{DEMO_PASSWORD}</strong>. Toca una para ingresar.
            </p>
            {['BECARIO', 'COORDINADOR', 'TUTOR', 'MENTOR'].map((g) => (
              <div key={g} style={{ marginBottom: 10 }}>
                <strong className="small">{ROLE_LABEL[g]}</strong>
                {accounts
                  .filter((a) => a.role === g)
                  .map((a) => (
                    <button
                      key={a.dni}
                      className="card secondary"
                      style={{ display: 'block', width: '100%', textAlign: 'left', color: 'inherit', margin: '6px 0' }}
                      disabled={busy}
                      onClick={() => {
                        setDni(a.dni);
                        setPassword(DEMO_PASSWORD);
                        submit(undefined, { dni: a.dni, password: DEMO_PASSWORD });
                      }}
                    >
                      <span className="spread">
                        <strong>{a.name}</strong>
                        <span className="small muted">DNI {a.dni}</span>
                      </span>
                      <span className="small muted">
                        {a.specialty === 'PSICOLOGIA' ? 'Psicología · ' : a.specialty === 'ACADEMICO' ? 'Tutoría académica · ' : ''}
                        {a.university}
                      </span>
                      {a.persona && <span className="small" style={{ display: 'block', marginTop: 4 }}>{a.persona}</span>}
                    </button>
                  ))}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
