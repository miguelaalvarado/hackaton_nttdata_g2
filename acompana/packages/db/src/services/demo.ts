import { clamp, createRng, sampleWeek, type LatentStudent, type WeeklySignals } from '@acompana/domain';
import { prisma, type Prisma } from '../index';
import { currentWeek, weekStartFor } from './clock';
import { deliverMessage } from './outbound';
import { recalcAll } from './recalc';

/**
 * Solo demo: avanza el reloj una semana, genera las señales sintéticas de la nueva semana y recalcula todo.
 * Las personas de la demo responden a la atención humana: si su alerta tuvo acción, mejoran; si no, empeoran.
 */
export async function advanceDemoWeek() {
  const clock = await prisma.demoClock.findUniqueOrThrow({ where: { id: 1 } });
  const before = await currentWeek();
  const week = clock.weekNumber + 1;
  await prisma.demoClock.update({ where: { id: 1 }, data: { weekNumber: week, offsetDays: clock.offsetDays + 7 } });
  const { weekStart, now } = await currentWeek();
  const rng = createRng(1000 + week);

  const scholars = await prisma.scholar.findMany({
    include: {
      enrollments: true,
      signals: { orderBy: { weekStart: 'desc' }, take: 1 },
      alerts: { where: { direction: 'TEAM' }, include: { actions: true } },
      goals: { orderBy: { weekStart: 'desc' }, take: 1 },
    },
  });
  for (const s of scholars) {
    const latent = s.synthLatent as unknown as LatentStudent | null;
    const last = s.signals[0];
    if (!latent || !last) continue;
    const failed = s.enrollments.filter((e) => e.status === 'DESAPROBADO').length;
    const attended = s.alerts.some((a) => a.actions.length > 0);
    let sig: WeeklySignals = { ...sampleWeek(latent, week, rng, failed), studyHoursTarget: latent.studyHoursTarget };
    sig.avgPartial = last.avgPartial === null ? sig.avgPartial : Math.round(clamp(last.avgPartial + rng.normal(attended ? 0.3 : 0, 0.3), 0, 20) * 10) / 10;

    if (s.id === 'sch-ana') sig = { ...sig, attendanceRate: 0.95, activeDays: 6, studyHours: 12, mood: 4, avgPartial: 15.9 };
    if (s.id === 'sch-luis') {
      sig = attended
        ? { ...sig, attendanceRate: 0.88, activeDays: 4, studyHours: 9, mood: 4, avgPartial: 11.6 }
        : { ...sig, attendanceRate: 0.7, activeDays: 1, studyHours: 4, mood: 2, avgPartial: 10.1 };
    }
    if (s.id === 'sch-rosa') {
      sig = attended
        ? { ...sig, attendanceRate: 0.88, activeDays: 5, studyHours: 10, mood: 3, avgPartial: 13.5 }
        : { ...sig, attendanceRate: 0.78, activeDays: 3, studyHours: 7, mood: 2, avgPartial: 12.9 };
    }

    await prisma.weeklySignal.upsert({
      where: { scholarId_weekStart: { scholarId: s.id, weekStart } },
      create: { scholarId: s.id, weekStart, weekNumber: week, ...sig },
      update: { ...sig, weekNumber: week },
    });
    if (sig.mood !== null) await prisma.moodCheckin.create({ data: { scholarId: s.id, score: sig.mood, channel: 'whatsapp', createdAt: now } });
    const prevGoal = s.goals[0];
    if (prevGoal) {
      await prisma.weeklyGoal.upsert({
        where: { scholarId_weekStart: { scholarId: s.id, weekStart } },
        create: {
          scholarId: s.id,
          weekStart,
          attendanceTarget: prevGoal.attendanceTarget,
          studyHoursTarget: prevGoal.studyHoursTarget,
          courseGoals: (prevGoal.courseGoals as { name: string; target: number; courseId: string; reinforcement: boolean }[])
            .filter((c) => !c.courseId.endsWith('-NIV'))
            .map((c) => ({ ...c, topic: null, done: Math.round(((sig.studyHours / latent.studyHoursTarget) * c.target) * 10) / 10 })) as Prisma.InputJsonValue,
        },
        update: {},
      });
    }
  }
  await deliverDueMessages();
  const recalc = await recalcAll();
  return { from: before.weekStart, to: weekStart, weekNumber: week, recalc, check: weekStartFor(week, week, weekStart) };
}

/** Entrega los mensajes diferidos cuya hora ya llegó (respaldo si la cola no está corriendo). */
export async function deliverDueMessages() {
  const { now } = await currentWeek();
  const due = await prisma.message.findMany({ where: { status: 'PROGRAMADO', scheduledFor: { lte: now } }, select: { id: true } });
  for (const m of due) await deliverMessage(m.id);
  return due.length;
}
