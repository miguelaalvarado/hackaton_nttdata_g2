import { buildStudyPlan, canMarkBlock, premarkDoneBlocks, zonedParts, type PlanCourse } from '@acompana/domain';
import { prisma, type Prisma } from '../index';
import { currentWeek } from './clock';
import { HttpErrorLike } from './errors';

const TZ = 'America/Lima';

export async function todayDow(): Promise<number> {
  const { now } = await currentWeek();
  const p = zonedParts(now, TZ);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Devuelve el plan de la semana actual del becario; si no existe, lo genera con buildStudyPlan y lo guarda. */
export async function ensureStudyPlan(scholarId: string) {
  const { weekStart, weekNumber } = await currentWeek();
  const existing = await prisma.studyPlan.findUnique({
    where: { scholarId_weekStart: { scholarId, weekStart } },
    include: { blocks: { orderBy: [{ dow: 'asc' }, { start: 'asc' }] } },
  });
  if (existing) return existing;

  const s = await prisma.scholar.findUniqueOrThrow({
    where: { id: scholarId },
    include: {
      ruleSet: true,
      onboarding: true,
      enrollments: { include: { course: true } },
      goals: { orderBy: { weekStart: 'desc' }, take: 1 },
      profiles: { orderBy: { createdAt: 'desc' }, take: 1 },
      signals: { where: { weekStart }, take: 1 },
    },
  });
  if (!s.onboardingDoneAt) return null;

  const courses: PlanCourse[] = s.enrollments
    .filter((e) => e.status === 'EN_CURSO')
    .map((e) => ({
      id: e.courseId,
      name: e.course.name,
      credits: e.course.credits,
      schedule: e.course.schedule as PlanCourse['schedule'],
      avgGrade: e.partialGrades.length ? Math.round((e.partialGrades.reduce((a, b) => a + b, 0) / e.partialGrades.length) * 10) / 10 : null,
      topic: (e.course.weeklyTopics as Record<string, string>)[String(weekNumber)] ?? null,
    }));
  const plan = buildStudyPlan({
    courses,
    studyHoursTarget: s.goals[0]?.studyHoursTarget ?? 12,
    passingGrade: s.ruleSet.passingGrade,
    gpaWarningMargin: s.ruleSet.gpaWarningMargin,
    diagnostic: { math: s.onboarding?.mathScore ?? null, reading: s.onboarding?.readingScore ?? null },
    failedCourseNames: s.enrollments.filter((e) => e.status === 'DESAPROBADO').map((e) => e.course.name),
    profiles: s.profiles[0]?.profiles ?? [],
  });
  const done = premarkDoneBlocks(plan.blocks, s.signals[0]?.studyHours ?? 0, await todayDow());
  const { now } = await currentWeek();

  return prisma.studyPlan.create({
    data: {
      scholarId,
      weekStart,
      priorities: plan.priorities as unknown as Prisma.InputJsonValue,
      notes: plan.notes,
      createdAt: now,
      blocks: { create: plan.blocks.map((b, i) => ({ ...b, doneAt: done[i] ? now : null })) },
    },
    include: { blocks: { orderBy: [{ dow: 'asc' }, { start: 'asc' }] } },
  });
}

/**
 * El becario marca (o desmarca) un bloque. Actualiza sus horas de estudio de la semana y el avance del curso:
 * así el semáforo y el asistente usan lo que realmente cumplió.
 */
export async function markStudyBlock(scholarId: string, blockId: string, done: boolean) {
  const block = await prisma.studyBlock.findUnique({ where: { id: blockId }, include: { plan: true } });
  if (!block || block.plan.scholarId !== scholarId) throw new HttpErrorLike(404, 'BLOQUE_NO_ENCONTRADO', 'Bloque no encontrado.');
  const { now, weekStart } = await currentWeek();
  if (block.plan.weekStart !== weekStart) throw new HttpErrorLike(409, 'SEMANA_CERRADA', 'Ese bloque es de una semana anterior.');
  if (done && !canMarkBlock(block.dow, await todayDow())) {
    throw new HttpErrorLike(409, 'BLOQUE_FUTURO', 'Podrás marcarlo cuando llegue ese día.');
  }
  if (Boolean(block.doneAt) === done) return block;

  const delta = (done ? 1 : -1) * (block.minutes / 60);
  const updated = await prisma.studyBlock.update({ where: { id: blockId }, data: { doneAt: done ? now : null } });
  const signal = await prisma.weeklySignal.findUnique({ where: { scholarId_weekStart: { scholarId, weekStart } } });
  if (signal) {
    await prisma.weeklySignal.update({ where: { id: signal.id }, data: { studyHours: Math.max(0, Math.round((signal.studyHours + delta) * 100) / 100) } });
  }
  const goal = await prisma.weeklyGoal.findFirst({ where: { scholarId }, orderBy: { weekStart: 'desc' } });
  if (goal && block.courseId) {
    const goals = (goal.courseGoals as { courseId: string; done: number }[]).map((c) =>
      c.courseId === block.courseId ? { ...c, done: Math.max(0, Math.round((c.done + delta) * 10) / 10) } : c,
    );
    await prisma.weeklyGoal.update({ where: { id: goal.id }, data: { courseGoals: goals as Prisma.InputJsonValue } });
  }
  return updated;
}
