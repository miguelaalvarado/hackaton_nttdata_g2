'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { setSession } from '@/lib/api';
import { useSession } from '@/components/useSession';

const TABS = [
  ['/becario', 'Inicio'],
  ['/becario/plan', 'Mi plan'],
  ['/becario/kit', 'Kit de llegada'],
  ['/becario/chat', 'WhatsApp'],
] as const;

export default function BecarioLayout({ children }: { children: React.ReactNode }) {
  const user = useSession(['BECARIO']);
  const path = usePathname();
  const router = useRouter();
  if (!user) return null;
  return (
    <div className="phone">
      <div className="phone-h">
        <strong>Acompaña</strong>
        <button className="secondary" style={{ color: 'inherit', borderColor: 'currentColor', padding: '3px 10px' }} onClick={() => { setSession(null); router.push('/'); }}>
          Salir
        </button>
      </div>
      <main>{children}</main>
      {!path.startsWith('/becario/onboarding') && (
        <nav className="tabbar">
          {TABS.map(([href, label]) => (
            <Link key={href} href={href} className={path === href ? 'active' : ''}>
              {label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
