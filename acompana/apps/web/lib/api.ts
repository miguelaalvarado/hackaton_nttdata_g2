'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface SessionUser {
  sub: string;
  name: string;
  role: 'BECARIO' | 'MENTOR' | 'TUTOR' | 'COORDINADOR';
  specialty: 'ACADEMICO' | 'PSICOLOGIA' | null;
  universityId: string | null;
  scholarId: string | null;
}

export function getSession(): { token: string; user: SessionUser } | null {
  try {
    const raw = localStorage.getItem('acompana.session');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(s: { token: string; user: SessionUser } | null) {
  try {
    if (s) localStorage.setItem('acompana.session', JSON.stringify(s));
    else localStorage.removeItem('acompana.session');
  } catch {
    /* almacenamiento no disponible */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const s = getSession();
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.code ?? 'ERROR', data.message ?? 'Error');
  return data as T;
}

export const COLOR_LABEL: Record<string, string> = { VERDE: 'Verde', AMARILLO: 'Amarillo', ROJO: 'Rojo', SIN_DATOS: 'Sin datos' };
export const PROFILE_LABEL: Record<string, string> = {
  ESTABLE: 'Estable',
  BARRERA_ACADEMICA: 'Barrera académica',
  TIEMPO_RECURSOS: 'Tiempo y recursos',
  INTEGRACION: 'Integración',
  MOTIVACION_VOCACION: 'Motivación y vocación',
  MALESTAR_EMOCIONAL: 'Malestar emocional',
  EVENTO_VIDA: 'Evento de vida',
};
export const SLA_LABEL: Record<string, string> = {
  EN_PLAZO: 'En plazo',
  VENCIDA: 'Vencida',
  CUMPLIDA: 'Atendida a tiempo',
  INCUMPLIDA: 'Atendida fuera de plazo',
  SIN_SLA: 'Sin plazo',
};
export const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
