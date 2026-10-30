'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, type SessionUser } from '@/lib/api';

/** Devuelve la sesión o redirige al inicio si no hay sesión o el rol no corresponde. */
export function useSession(roles: SessionUser['role'][]): SessionUser | null {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  useEffect(() => {
    const s = getSession();
    if (!s || !roles.includes(s.user.role)) router.replace('/');
    else setUser(s.user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return user;
}
