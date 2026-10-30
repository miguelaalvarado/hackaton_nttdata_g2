import { maxColor, PLAYBOOKS, type Owner } from './playbooks';
import type { ProfileResult } from './profiles';
import type { RiskResult } from './risk/semaforo';
import type { Color, Profile } from './types';

export interface SlaConfig {
  /** Horas para atender según severidad. Rojo = 48 h por regla del programa. */
  hoursBySeverity: Record<Exclude<Color, 'VERDE'>, number>;
}
export const DEFAULT_SLA: SlaConfig = { hoursBySeverity: { ROJO: 48, AMARILLO: 168 } };

export interface AlertDraft {
  dedupeKey: string;
  direction: 'SCHOLAR' | 'TEAM';
  severity: Exclude<Color, 'VERDE'>;
  profile: Profile;
  reason: string;
  nextStep: string;
  owner: Owner | null;
  dueAt: Date | null;
}

/**
 * Convierte riesgo + perfiles de la semana en alertas:
 * una al equipo por perfil activo (con responsable) y una al becario con el siguiente paso del perfil prioritario.
 */
export function buildAlerts(args: {
  scholarId: string;
  weekKey: string;
  risk: RiskResult;
  profiles: ProfileResult;
  now: Date;
  sla?: SlaConfig;
}): AlertDraft[] {
  const { scholarId, weekKey, risk, profiles, now, sla = DEFAULT_SLA } = args;
  if (profiles.primary === 'ESTABLE' && risk.color === 'VERDE') return [];

  const drafts: AlertDraft[] = [];
  const active = profiles.profiles.filter((p): p is Exclude<Profile, 'ESTABLE'> => p !== 'ESTABLE');
  const topReason = risk.reasons.find((r) => r.direction === 'SUBE')?.text ?? 'Señales de riesgo en la semana';

  for (const p of active) {
    const pb = PLAYBOOKS[p];
    const severity = maxColor(pb.minSeverity, risk.color) as Exclude<Color, 'VERDE'>;
    drafts.push({
      dedupeKey: `${scholarId}:${p}:${weekKey}:TEAM`,
      direction: 'TEAM',
      severity,
      profile: p,
      reason: `${(profiles.evidence[p] ?? []).join('; ')}. ${topReason}.`,
      nextStep: pb.teamAction,
      owner: pb.owner,
      dueAt: addHours(now, sla.hoursBySeverity[severity]),
    });
  }

  // Riesgo amarillo/rojo sin perfil específico: seguimiento general del coordinador.
  if (!active.length) {
    const severity = risk.color as Exclude<Color, 'VERDE'>;
    drafts.push({
      dedupeKey: `${scholarId}:ESTABLE:${weekKey}:TEAM`,
      direction: 'TEAM',
      severity,
      profile: 'ESTABLE',
      reason: topReason,
      nextStep: 'Revisar señales de la semana y contactar al becario.',
      owner: { role: 'COORDINADOR' },
      dueAt: addHours(now, sla.hoursBySeverity[severity]),
    });
  }

  if (active.length) {
    const primary = active[0];
    drafts.push({
      dedupeKey: `${scholarId}:${primary}:${weekKey}:SCHOLAR`,
      direction: 'SCHOLAR',
      severity: maxColor(PLAYBOOKS[primary].minSeverity, risk.color) as Exclude<Color, 'VERDE'>,
      profile: primary,
      reason: 'Tu semana',
      nextStep: PLAYBOOKS[primary].scholarNextStep,
      owner: null,
      dueAt: null,
    });
  }
  return drafts;
}

export type SlaStatus = 'EN_PLAZO' | 'VENCIDA' | 'CUMPLIDA' | 'INCUMPLIDA' | 'SIN_SLA';

/** "Atendida" = primera acción humana registrada. */
export function slaStatus(a: { dueAt: Date | null; firstActionAt: Date | null }, now: Date): SlaStatus {
  if (!a.dueAt) return 'SIN_SLA';
  if (a.firstActionAt) return a.firstActionAt <= a.dueAt ? 'CUMPLIDA' : 'INCUMPLIDA';
  return now <= a.dueAt ? 'EN_PLAZO' : 'VENCIDA';
}

/** Registra la primera acción humana. Las siguientes acciones no cambian el resultado del SLA. */
export function registerFirstAction(
  a: { dueAt: Date | null; firstActionAt: Date | null; slaMet: boolean | null },
  at: Date,
): { firstActionAt: Date; slaMet: boolean | null } {
  if (a.firstActionAt) return { firstActionAt: a.firstActionAt, slaMet: a.slaMet };
  return { firstActionAt: at, slaMet: a.dueAt ? at <= a.dueAt : null };
}

export const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);
