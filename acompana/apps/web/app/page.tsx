'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setSession } from '@/lib/api';
import { ErrorBox } from '@/components/ui';

interface DemoUser {
  id: string;
  name: string;
  role: string;
  specialty: string | null;
  university: string;
  persona: string | null;
}

const ROLE_LABEL: Record<string, string> = { BECARIO: 'Becario/a', MENTOR: 'Mentor par', TUTOR: 'Tutor/psicóloga', COORDINADOR: 'Coordinación' };

export default function Login() {
  const router = useRouter();
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DemoUser[]>('/auth/demo-users').then(setUsers).catch(() => setError('No se pudo conectar con la API. ¿Está corriendo en el puerto 4000?'));
  }, []);

  async function login(u: DemoUser) {
    const s = await api('/auth/demo-login', { body: { userId: u.id } });
    setSession(s);
    router.push(u.role === 'BECARIO' ? '/becario' : '/panel');
  }

  const groups = ['BECARIO', 'COORDINADOR', 'TUTOR', 'MENTOR'];
  return (
    <div className="wrap" style={{ maxWidth: 900 }}>
      <h1 className="brand">Acompaña</h1>
      <p className="muted">
        Prevención del abandono en becarios de Beca 18 durante su primer ciclo. Demo con <strong>datos sintéticos</strong>: elige con quién entrar.
      </p>
      <ErrorBox error={error} />
      {groups.map((g) => (
        <section key={g}>
          <h2>{ROLE_LABEL[g]}</h2>
          <div className="grid g2">
            {users
              .filter((u) => u.role === g)
              .map((u) => (
                <button key={u.id} className="card secondary" style={{ textAlign: 'left', color: 'inherit' }} onClick={() => login(u)}>
                  <strong>{u.name}</strong>
                  <div className="small muted">
                    {u.specialty === 'PSICOLOGIA' ? 'Psicología · ' : u.specialty === 'ACADEMICO' ? 'Tutoría académica · ' : ''}
                    {u.university}
                  </div>
                  {u.persona && <div className="small" style={{ marginTop: 6 }}>{u.persona}</div>}
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
