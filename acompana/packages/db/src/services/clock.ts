import { weekKey } from '@acompana/domain';
import { prisma } from '../index';

const TZ = 'America/Lima';
const DAY = 86_400_000;

/** Reloj de la demo: hora real + desfase en días (para "avanzar semana" sin esperar). */
export async function demoNow(): Promise<Date> {
  const c = await prisma.demoClock.findUnique({ where: { id: 1 } });
  return new Date(Date.now() + (c?.offsetDays ?? 0) * DAY);
}

export async function currentWeek(): Promise<{ now: Date; weekNumber: number; weekStart: string }> {
  const c = await prisma.demoClock.findUnique({ where: { id: 1 } });
  const now = new Date(Date.now() + (c?.offsetDays ?? 0) * DAY);
  return { now, weekNumber: c?.weekNumber ?? 1, weekStart: weekKey(now, TZ) };
}

/** Clave de semana N del ciclo, sabiendo que la semana actual es `current` y empieza en `currentStart`. */
export function weekStartFor(n: number, current: number, currentStart: string): string {
  const d = new Date(`${currentStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - current) * 7);
  return d.toISOString().slice(0, 10);
}
