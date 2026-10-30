import { zonedParts } from '@acompana/domain';
import { TEMPLATES } from '@acompana/messaging';
import { prisma } from '../index';
import { currentWeek } from './clock';
import { deliverDueMessages } from './demo';
import { deliverMessage, sendToScholar } from './outbound';
import { QUEUES, startQueue } from './queue';
import { recalcAll } from './recalc';

/**
 * Procesos de la cola: entregas y reintentos, recordatorios de clase, check-ins y recálculo semanal.
 * Lo arranca apps/worker; también puede correr dentro de la API (WORKER_IN_PROCESS=true) en despliegues de un solo servicio.
 */
export async function startWorker() {
  const boss = await startQueue();
  const TZ = 'America/Lima';

  await boss.work<{ messageId: string }>(QUEUES.deliver, async ([job]) => {
    await deliverMessage(job.data.messageId);
  });

  /** Recordatorio UTILITY de la primera clase del día (ligado a una clase concreta). El tope diario lo aplica policyGate. */
  await boss.work(QUEUES.classReminders, async () => {
    const { now } = await currentWeek();
    const p = zonedParts(now, TZ);
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const scholars = await prisma.scholar.findMany({
      where: { consents: { some: { type: 'WHATSAPP', revokedAt: null } } },
      include: { user: true, enrollments: { where: { status: 'EN_CURSO' }, include: { course: true } } },
    });
    for (const s of scholars) {
      const today = s.enrollments
        .flatMap((e) => (e.course.schedule as { dow: number; time: string; room: string }[]).filter((x) => x.dow === dow).map((x) => ({ ...x, course: e.course.name })))
        .sort((a, b) => a.time.localeCompare(b.time))[0];
      if (!today) continue;
      await sendToScholar({
        scholarId: s.id,
        intent: { initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: TEMPLATES.recordatorio_clase.name },
        templateParams: [s.user.name.split(' ')[0], today.course, today.time, today.room],
      });
    }
  });

  /** Check-in semanal (MARKETING, termina en pregunta para reabrir la ventana de 24 h). */
  await boss.work(QUEUES.weeklyCheckin, async () => {
    const scholars = await prisma.scholar.findMany({ where: { consents: { some: { type: 'WHATSAPP', revokedAt: null } } }, include: { user: true } });
    for (const s of scholars) {
      await sendToScholar({
        scholarId: s.id,
        intent: { initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: TEMPLATES.checkin_semanal.name },
        templateParams: [s.user.name.split(' ')[0]],
      });
    }
  });

  await boss.work(QUEUES.weeklyRecalc, async () => {
    console.log('[worker] recálculo semanal', await recalcAll());
  });

  await boss.work(QUEUES.dueSweep, async () => {
    const n = await deliverDueMessages();
    if (n) console.log(`[worker] ${n} mensajes diferidos procesados`);
  });

  // Horarios en hora de Lima (fuera del silencio 22:00–07:00).
  await boss.schedule(QUEUES.weeklyRecalc, '0 6 * * 1', {}, { tz: TZ });
  await boss.schedule(QUEUES.classReminders, '5 7 * * 1-5', {}, { tz: TZ });
  await boss.schedule(QUEUES.weeklyCheckin, '0 17 * * 5', {}, { tz: TZ });
  await boss.schedule(QUEUES.dueSweep, '*/5 * * * *', {}, { tz: TZ });
  console.log('[worker] listo: entregas, reintentos, recordatorios, check-ins y recálculo semanal');
  return boss;
}
