import {
  buildAlerts,
  computeRisk,
  detectProfiles,
  riskModel,
  type AlertDraft,
  type LogisticModel,
  type Owner,
  type RuleSetConfig,
  type WeeklySignals,
} from '@acompana/domain';
import { prisma, type Prisma, type RuleSet, type WeeklySignal } from '../index';
import { getSettings } from './config';
import { currentWeek } from './clock';

export const toRuleConfig = (r: RuleSet): RuleSetConfig => ({
  code: r.code,
  name: r.name,
  legalRef: r.legalRef,
  passingGrade: r.passingGrade,
  gpaWarningMargin: r.gpaWarningMargin,
  minCreditsPerTerm: r.minCreditsPerTerm,
  requireTopThird: r.requireTopThird,
  failRuleApplies: r.failRuleApplies,
  maxFailedCourses: r.maxFailedCourses,
});

export const toSignals = (s: WeeklySignal): WeeklySignals => ({
  attendanceRate: s.attendanceRate,
  activeDays: s.activeDays,
  studyHours: s.studyHours,
  studyHoursTarget: s.studyHoursTarget,
  avgPartial: s.avgPartial,
  failedAttempts: s.failedAttempts,
  mood: s.mood,
});

/** Responsable concreto para un playbook: misma universidad; para mentor, el mentor asignado al becario. */
export async function resolveAssignee(owner: Owner | null, scholarId: string, universityId: string): Promise<string | null> {
  if (!owner) return null;
  if (owner.role === 'MENTOR') {
    const m = await prisma.mentorAssignment.findFirst({ where: { scholarId, active: true } });
    if (m) return m.mentorId;
  }
  const user = await prisma.user.findFirst({
    where: {
      role: owner.role,
      universityId,
      ...(owner.role === 'TUTOR' ? { specialty: owner.specialty } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  return user?.id ?? null;
}

export interface RecalcResult {
  scholarId: string;
  color: string;
  profiles: string[];
  alertsCreated: number;
}

/**
 * Recalcula semáforo + perfiles de un becario para la semana y crea las alertas que correspondan.
 * Se usa en el recálculo semanal y, de inmediato, cuando el chat detecta malestar o crisis.
 */
export async function recalcScholar(
  scholarId: string,
  opts: { weekStart?: string; now?: Date; source?: string; settings?: Awaited<ReturnType<typeof getSettings>> } = {},
): Promise<RecalcResult> {
  const settings = opts.settings ?? (await getSettings());
  const cw = await currentWeek();
  const weekStart = opts.weekStart ?? cw.weekStart;
  const now = opts.now ?? cw.now;

  const s = await prisma.scholar.findUniqueOrThrow({
    where: { id: scholarId },
    include: {
      ruleSet: true,
      onboarding: true,
      signals: { where: { weekStart: { lte: weekStart } }, orderBy: { weekStart: 'desc' }, take: 2 },
      moods: { where: { score: { not: null } }, orderBy: { createdAt: 'desc' }, take: 4 },
      checklist: { where: { doneAt: null, dueDate: { lt: now } } },
    },
  });
  const [current, previous] = s.signals;
  if (!current) return { scholarId, color: 'SIN_DATOS', profiles: [], alertsCreated: 0 };

  // Malestar o crisis expresados en los últimos 7 días.
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const levels = await prisma.moodCheckin.findMany({
    where: { scholarId, createdAt: { gte: weekAgo }, level: { in: ['MALESTAR', 'CRISIS'] } },
    select: { level: true },
  });
  const crisis = levels.some((l) => l.level === 'CRISIS');
  const distress = levels.length > 0;

  const rules = toRuleConfig(s.ruleSet);
  const signals = toSignals(current);
  const risk = computeRisk({ signals, rules, crisis }, riskModel as LogisticModel, settings.riskThresholds);
  const profiles = detectProfiles(
    {
      current: signals,
      previous: previous ? toSignals(previous) : null,
      recentMoods: s.moods.map((m) => m.score!),
      rules,
      onboarding: {
        careerFit: s.onboarding?.careerFit ?? null,
        mathScore: s.onboarding?.mathScore ?? null,
        readingScore: s.onboarding?.readingScore ?? null,
        livesAlone: s.livesAlone,
        studiesAwayFromHome: s.onboarding?.studiesAwayFromHome ?? s.originRegionId !== (await uniRegion(s.universityId)),
      },
      overdueChecklistItems: s.checklist.length,
      lifeEventReported: s.lifeEventReported,
      distressLanguage: distress,
      crisis,
    },
    settings.profileThresholds,
  );

  await prisma.$transaction([
    prisma.riskSnapshot.deleteMany({ where: { scholarId, weekStart } }),
    prisma.profileSnapshot.deleteMany({ where: { scholarId, weekStart } }),
    prisma.riskSnapshot.create({
      data: {
        scholarId,
        weekStart,
        color: risk.color,
        probability: risk.probability,
        reasons: risk.reasons as unknown as Prisma.InputJsonValue,
        rulesFired: risk.rulesFired,
        modelVersion: risk.modelVersion,
        createdAt: now,
      },
    }),
    prisma.profileSnapshot.create({
      data: {
        scholarId,
        weekStart,
        profiles: profiles.profiles,
        primary: profiles.primary,
        evidence: profiles.evidence as Prisma.InputJsonValue,
        createdAt: now,
      },
    }),
  ]);

  const drafts = buildAlerts({ scholarId, weekKey: weekStart, risk, profiles, now, sla: settings.sla });
  let created = 0;
  for (const d of drafts) created += (await upsertAlert(d, scholarId, s.universityId, now, opts.source ?? 'RECALCULO_SEMANAL')) ? 1 : 0;
  return { scholarId, color: risk.color, profiles: profiles.profiles, alertsCreated: created };
}

const regionCache = new Map<string, string>();
async function uniRegion(universityId: string): Promise<string> {
  if (!regionCache.has(universityId)) {
    const u = await prisma.university.findUniqueOrThrow({ where: { id: universityId } });
    regionCache.set(universityId, u.regionId);
  }
  return regionCache.get(universityId)!;
}

/**
 * Crea la alerta si no existe para esa clave (becario, perfil, semana, dirección).
 * Si ya existe una de menor severidad y la nueva es roja, la escala y reinicia el plazo de 48 h.
 */
async function upsertAlert(d: AlertDraft, scholarId: string, universityId: string, now: Date, source: string): Promise<boolean> {
  const existing = await prisma.alert.findUnique({ where: { dedupeKey: d.dedupeKey } });
  if (existing) {
    if (existing.severity !== 'ROJO' && d.severity === 'ROJO' && existing.status !== 'CERRADA') {
      await prisma.alert.update({
        where: { id: existing.id },
        data: { severity: 'ROJO', dueAt: d.dueAt, reason: d.reason, source, firstActionAt: null, slaMet: null, status: 'ABIERTA' },
      });
      return true;
    }
    return false;
  }
  await prisma.alert.create({
    data: {
      dedupeKey: d.dedupeKey,
      scholarId,
      direction: d.direction,
      severity: d.severity,
      profile: d.profile,
      reason: d.reason,
      nextStep: d.nextStep,
      assigneeId: await resolveAssignee(d.owner, scholarId, universityId),
      dueAt: d.dueAt,
      source,
      createdAt: now,
    },
  });
  return true;
}

/** Recalcula a todos los becarios (job semanal). */
export async function recalcAll(): Promise<{ total: number; byColor: Record<string, number>; alertsCreated: number }> {
  const settings = await getSettings();
  const ids = await prisma.scholar.findMany({ select: { id: true } });
  const byColor: Record<string, number> = {};
  let alertsCreated = 0;
  for (const { id } of ids) {
    const r = await recalcScholar(id, { settings });
    byColor[r.color] = (byColor[r.color] ?? 0) + 1;
    alertsCreated += r.alertsCreated;
  }
  return { total: ids.length, byColor, alertsCreated };
}
