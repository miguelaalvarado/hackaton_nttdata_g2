'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { setSession } from '@/lib/api';
import { useSession } from '@/components/useSession';

const ROLE: Record<string, string> = { COORDINADOR: 'Coordinación', TUTOR: 'Tutoría', MENTOR: 'Mentoría' };

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = useSession(['COORDINADOR', 'TUTOR', 'MENTOR']);
  const router = useRouter();
  if (!user) return null;
  return (
    <>
      <nav className="topnav">
        <div className="wrap">
          <span className="brand">Acompaña</span>
          <Link href="/panel">Becarios</Link>
          <Link href="/panel/alertas">{user.role === 'COORDINADOR' ? 'Alertas' : 'Mis alertas'}</Link>
          <span style={{ flex: 1 }} />
          <span className="small muted">
            {user.name} · {user.specialty === 'PSICOLOGIA' ? 'Psicología' : ROLE[user.role]}
            {user.universityId ? '' : ' · Pronabec'}
          </span>
          <button className="secondary" onClick={() => { setSession(null); router.push('/'); }}>Salir</button>
        </div>
      </nav>
      <div className="wrap">{children}</div>
    </>
  );
}
