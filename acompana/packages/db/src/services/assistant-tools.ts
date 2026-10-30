import { evaluateScholarshipRules, normalizeText, zonedParts } from '@acompana/domain';
import type { ToolCall } from '@acompana/llm';
import { prisma } from '../index';
import { currentWeek } from './clock';
import { getSettings } from './config';
import { toRuleConfig } from './recalc';
import { ensureStudyPlan, todayDow } from './study-plan';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export interface ToolEffects {
  humanRequested: { reason: string; team: string } | null;
  moodLogged: number | null;
}

/** Situación académica del becario frente a su cohorte (para el becario y para el asistente). */
export async function rulesStatus(scholarId: string) {
  const s = await prisma.scholar.findUniqueOrThrow({
    where: { id: scholarId },
    include: { ruleSet: true, enrollments: { include: { course: true } } },
  });
  const failedAttempts = s.enrollments.filter((e) => e.status === 'DESAPROBADO').length;
  let wSum = 0;
  let cSum = 0;
  for (const e of s.enrollments) {
    const g = e.finalGrade ?? (e.partialGrades.length ? e.partialGrades.reduce((a, b) => a + b, 0) / e.partialGrades.length : null);
    if (g !== null) {
      wSum += g * e.course.credits;
      cSum += e.course.credits;
    }
  }
  const rules = evaluateScholarshipRules(toRuleConfig(s.ruleSet), {
    weightedAverage: cSum ? Math.round((wSum / cSum) * 10) / 10 : null,
    termClosed: false,
    enrolledCredits: s.enrolledCredits,
    cohortPercentile: s.cohortPercentile,
    failedAttempts,
  });
  return { cohort: s.ruleSet.name, legalRef: s.ruleSet.legalRef, rules };
}

/** Ejecuta las herramientas del asistente con los datos del becario (solo lectura salvo check-in y pedido de ayuda). */
export function makeToolRunner(scholarId: string, effects: ToolEffects) {
  return async (call: ToolCall): Promise<string> => {
    switch (call.name) {
      case 'get_schedule': {
        const { now } = await currentWeek();
        const days = Math.min(Number(call.input.days ?? 2), 7);
        const enr = await prisma.enrollment.findMany({ where: { scholarId, status: 'EN_CURSO' }, include: { course: true } });
        const p = zonedParts(now, 'America/Lima');
        const today = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
        const sessions = enr
          .flatMap((e) =>
            (e.course.schedule as { dow: number; time: string; room: string }[]).map((x) => ({
              course: e.course.name,
              offset: (x.dow - today + 7) % 7,
              day: DAYS[x.dow],
              time: x.time,
              room: x.room,
            })),
          )
          .filter((x) => x.offset < days)
          .sort((a, b) => a.offset - b.offset || a.time.localeCompare(b.time));
        return JSON.stringify({ sessions });
      }
      case 'get_weekly_goals': {
        const { weekStart } = await currentWeek();
        const goal = await prisma.weeklyGoal.findUnique({ where: { scholarId_weekStart: { scholarId, weekStart } } });
        const sig = await prisma.weeklySignal.findUnique({ where: { scholarId_weekStart: { scholarId, weekStart } } });
        const courses = ((goal?.courseGoals ?? []) as { name: string; target: number; done: number; reinforcement: boolean }[]).map((c) => ({
          ...c,
          progress: c.target ? Math.min(c.done / c.target, 1) : 1,
        }));
        const plan = await ensureStudyPlan(scholarId);
        const today = await todayDow();
        const norm = (d: number) => (d === 0 ? 7 : d);
        const next = plan?.blocks.find((b) => !b.doneAt && norm(b.dow) >= norm(today));
        return JSON.stringify({
          nextBlock: next ? { title: next.title, day: DAYS[next.dow], isToday: next.dow === today, start: next.start, minutes: next.minutes, topic: next.topic } : null,
          attendanceTarget: goal?.attendanceTarget,
          attendance: sig?.attendanceRate,
          studyHoursTarget: goal?.studyHoursTarget ?? sig?.studyHoursTarget,
          studyHours: sig?.studyHours ?? 0,
          courses,
        });
      }
      case 'get_rules_status':
        return JSON.stringify(await rulesStatus(scholarId));
      case 'get_procedures_faq': {
        const topic = normalizeText(String(call.input.topic ?? ''));
        const { faq } = await getSettings();
        const hit = faq.find((f) => f.keywords.some((k) => topic.includes(k)));
        return JSON.stringify(hit ? { found: true, topic: hit.topic, answer: hit.answer } : { found: false });
      }
      case 'log_mood_checkin': {
        const score = Math.max(1, Math.min(5, Math.round(Number(call.input.score))));
        await prisma.moodCheckin.create({
          data: { scholarId, score, text: String(call.input.note ?? ''), channel: 'whatsapp', createdAt: (await currentWeek()).now },
        });
        const { weekStart } = await currentWeek();
        await prisma.weeklySignal.updateMany({ where: { scholarId, weekStart }, data: { mood: score } });
        effects.moodLogged = score;
        return JSON.stringify({ ok: true });
      }
      case 'request_human': {
        effects.humanRequested = { reason: String(call.input.reason ?? ''), team: String(call.input.team ?? 'COORDINADOR') };
        return JSON.stringify({ ok: true, message: 'El equipo fue notificado.' });
      }
      default:
        throw new Error(`Herramienta desconocida: ${call.name}`);
    }
  };
}
