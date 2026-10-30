import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@acompana/db';
import { currentWeek, ensureStudyPlan, getSettings, markStudyBlock, recalcScholar, rulesStatus, todayDow } from '@acompana/db/services';
import { HttpError, requireRole } from '../auth';
import { publicDiagnostic, scoreDiagnostic } from '../diagnostic';

const DAY = 86_400_000;

function me(req: { user: { scholarId: string | null } }): string {
  if (!req.user.scholarId) throw new HttpError(403, 'SIN_PERFIL_BECARIO', 'Tu usuario no tiene perfil de becario.');
  return req.user.scholarId;
}

export async function scholarRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireRole('BECARIO'));

  /** Inicio del becario: su semana, siguiente paso, reglas de su cohorte y kit. No se le muestra el puntaje de riesgo. */
  app.get('/scholar/home', async (req) => {
    const id = me(req);
    const { weekStart, weekNumber } = await currentWeek();
    const s = await prisma.scholar.findUniqueOrThrow({
      where: { id },
      include: {
        user: true,
        university: true,
        career: true,
        ruleSet: true,
        originRegion: true,
        consents: { where: { revokedAt: null } },
        checklist: { include: { item: true } },
        mentors: { where: { active: true }, include: { mentor: true } },
        alerts: { where: { direction: 'SCHOLAR', status: { not: 'CERRADA' } }, orderBy: { createdAt: 'desc' }, take: 1 },
        signals: { where: { weekStart }, take: 1 },
        goals: { where: { weekStart }, take: 1 },
      },
    });
    return {
      name: s.user.name,
      firstName: s.user.name.split(' ')[0],
      university: s.university.name,
      career: s.career.name,
      origin: s.originRegion.name,
      cohort: { code: s.ruleSet.code, name: s.ruleSet.name },
      week: { weekStart, weekNumber },
      onboardingDone: Boolean(s.onboardingDoneAt),
      consents: s.consents.map((c) => ({ type: c.type, acceptedAt: c.acceptedAt, textVersion: c.textVersion })),
      nextStep: s.alerts[0] ? { text: s.alerts[0].nextStep, profile: s.alerts[0].profile } : null,
      signals: s.signals[0] ?? null,
      goal: s.goals[0] ?? null,
      checklist: { total: s.checklist.length, done: s.checklist.filter((c) => c.doneAt).length },
      mentor: s.mentors[0] ? { name: s.mentors[0].mentor.name, reason: s.mentors[0].reason } : null,
      rules: s.onboardingDoneAt ? await rulesStatus(id) : null,
    };
  });

  app.get('/scholar/onboarding', async () => {
    const { consentTexts } = await getSettings();
    const regions = await prisma.region.findMany({ orderBy: { name: 'asc' } });
    return { diagnostic: publicDiagnostic(), consentTexts, regions };
  });

  const OnboardingBody = z.object({
    originRegionId: z.string(),
    livesAlone: z.boolean(),
    careerFit: z.number().int().min(1).max(5),
    mood: z.number().int().min(1).max(5),
    mathAnswers: z.array(z.number().int()).length(5),
    readingAnswers: z.array(z.number().int()).length(3),
    consents: z.object({ datos: z.boolean(), whatsapp: z.boolean() }),
    /** Versiones de texto que el becario vio (se guarda el texto exacto de esa versión). */
    consentVersions: z.object({ datos: z.string(), whatsapp: z.string() }),
  });

  app.post('/scholar/onboarding', async (req, reply) => {
    const id = me(req);
    const body = OnboardingBody.parse(req.body);
    if (!body.consents.datos) {
      return reply.code(400).send({
        code: 'CONSENTIMIENTO_DATOS_REQUERIDO',
        message: 'Sin tu autorización de datos (Ley 29733) no podemos acompañarte con la plataforma. Puedes seguir contactando a tu coordinador por los canales habituales.',
      });
    }
    const { consentTexts } = await getSettings();
    if (body.consentVersions.datos !== consentTexts.DATOS_LEY_29733.version || body.consentVersions.whatsapp !== consentTexts.WHATSAPP.version) {
      return reply.code(409).send({ code: 'TEXTO_CONSENTIMIENTO_CAMBIO', message: 'El texto del consentimiento cambió; vuelve a leerlo.' });
    }
    const { now, weekStart } = await currentWeek();
    const s = await prisma.scholar.findUniqueOrThrow({ where: { id }, include: { university: true, career: { include: { courses: true } } } });
    const { mathScore, readingScore } = scoreDiagnostic(body.mathAnswers, body.readingAnswers);
    const away = body.originRegionId !== s.university.regionId;
    const items = await prisma.checklistItem.findMany();

    await prisma.$transaction([
      prisma.scholar.update({ where: { id }, data: { originRegionId: body.originRegionId, livesAlone: body.livesAlone, onboardingDoneAt: now } }),
      prisma.onboardingAnswer.upsert({
        where: { scholarId: id },
        create: { scholarId: id, careerFit: body.careerFit, mood: body.mood, mathScore, readingScore, studiesAwayFromHome: away },
        update: { careerFit: body.careerFit, mood: body.mood, mathScore, readingScore, studiesAwayFromHome: away },
      }),
      prisma.consent.create({
        data: {
          scholarId: id,
          type: 'DATOS_LEY_29733',
          textVersion: consentTexts.DATOS_LEY_29733.version,
          textSnapshot: consentTexts.DATOS_LEY_29733.text,
          channel: 'web-onboarding',
          acceptedAt: now,
        },
      }),
      ...(body.consents.whatsapp
        ? [
            prisma.consent.create({
              data: {
                scholarId: id,
                type: 'WHATSAPP',
                textVersion: consentTexts.WHATSAPP.version,
                textSnapshot: consentTexts.WHATSAPP.text,
                channel: 'web-onboarding',
                acceptedAt: now,
              },
            }),
          ]
        : []),
      prisma.moodCheckin.create({ data: { scholarId: id, score: body.mood, channel: 'onboarding', createdAt: now } }),
      ...items.map((it) =>
        prisma.scholarChecklist.upsert({
          where: { scholarId_itemId: { scholarId: id, itemId: it.id } },
          create: { scholarId: id, itemId: it.id, dueDate: new Date(now.getTime() + it.dueDays * DAY) },
          update: {},
        }),
      ),
      ...s.career.courses
        .filter((c) => !c.id.endsWith('-NIV'))
        .map((c) =>
          prisma.enrollment.upsert({
            where: { scholarId_courseId_term_attempt: { scholarId: id, courseId: c.id, term: '2026-II', attempt: 1 } },
            create: { scholarId: id, courseId: c.id, term: '2026-II', partialGrades: [] },
            update: {},
          }),
        ),
      prisma.weeklyGoal.upsert({
        where: { scholarId_weekStart: { scholarId: id, weekStart } },
        create: {
          scholarId: id,
          weekStart,
          attendanceTarget: 0.9,
          studyHoursTarget: mathScore < 60 || readingScore < 60 ? 14 : 12,
          courseGoals: s.career.courses
            .filter((c) => !c.id.endsWith('-NIV'))
            .map((c) => ({ courseId: c.id, name: c.name, topic: null, target: Math.max(1, Math.round((12 * c.credits) / 20)), done: 0, reinforcement: (c.name.includes('Matemática') && mathScore < 60) || (c.name.includes('Comunicación') && readingScore < 60) })),
        },
        update: {},
      }),
    ]);
    await prisma.conversation.upsert({ where: { scholarId: id }, create: { scholarId: id }, update: {} });
    return { ok: true, mathScore, readingScore, reinforcement: { math: mathScore < 60, reading: readingScore < 60 } };
  });

  app.get('/scholar/checklist', async (req) => {
    const id = me(req);
    const { now } = await currentWeek();
    const rows = await prisma.scholarChecklist.findMany({ where: { scholarId: id }, include: { item: true }, orderBy: { dueDate: 'asc' } });
    return rows.map((r) => ({
      itemId: r.itemId,
      category: r.item.category,
      title: r.item.title,
      detail: r.item.detail,
      dueDate: r.dueDate,
      doneAt: r.doneAt,
      overdue: !r.doneAt && r.dueDate < now,
    }));
  });

  app.post('/scholar/checklist/:itemId', async (req) => {
    const id = me(req);
    const { itemId } = z.object({ itemId: z.string() }).parse(req.params);
    const { done } = z.object({ done: z.boolean() }).parse(req.body);
    const { now } = await currentWeek();
    await prisma.scholarChecklist.update({ where: { scholarId_itemId: { scholarId: id, itemId } }, data: { doneAt: done ? now : null } });
    return { ok: true };
  });

  /** Plan de estudio: metas de la semana, avance por curso con refuerzo, notas y reglas de su cohorte. */
  app.get('/scholar/plan', async (req) => {
    const id = me(req);
    const { weekStart, weekNumber } = await currentWeek();
    const [plan, goal, signal, enrollments] = await Promise.all([
      ensureStudyPlan(id),
      prisma.weeklyGoal.findFirst({ where: { scholarId: id }, orderBy: { weekStart: 'desc' } }),
      prisma.weeklySignal.findUnique({ where: { scholarId_weekStart: { scholarId: id, weekStart } } }),
      prisma.enrollment.findMany({ where: { scholarId: id }, include: { course: true }, orderBy: { course: { name: 'asc' } } }),
    ]);
    return {
      week: { weekStart, weekNumber },
      todayDow: await todayDow(),
      goal,
      signal,
      studyPlan: plan && { priorities: plan.priorities, notes: plan.notes, blocks: plan.blocks },
      classes: enrollments
        .filter((e) => e.status === 'EN_CURSO')
        .flatMap((e) => (e.course.schedule as { dow: number; time: string; room: string }[]).map((x) => ({ ...x, course: e.course.name }))),
      courses: enrollments.map((e) => ({
        name: e.course.name,
        credits: e.course.credits,
        status: e.status,
        partialGrades: e.partialGrades,
        finalGrade: e.finalGrade,
        topic: (e.course.weeklyTopics as Record<string, string>)[String(weekNumber)] ?? null,
      })),
      rules: await rulesStatus(id),
    };
  });

  /** El becario marca un bloque de su plan como hecho (o lo desmarca). */
  app.post('/scholar/plan/blocks/:blockId', async (req) => {
    const id = me(req);
    const { blockId } = z.object({ blockId: z.string() }).parse(req.params);
    const { done } = z.object({ done: z.boolean() }).parse(req.body);
    return markStudyBlock(id, blockId, done);
  });

  app.post('/scholar/consents/:type', async (req) => {
    const id = me(req);
    const { type } = z.object({ type: z.enum(['WHATSAPP', 'FAMILIA', 'DATOS_LEY_29733']) }).parse(req.params);
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    const { now } = await currentWeek();
    const { consentTexts } = await getSettings();
    if (!accept) {
      await prisma.consent.updateMany({ where: { scholarId: id, type, revokedAt: null }, data: { revokedAt: now } });
      if (type === 'WHATSAPP') {
        await prisma.conversation.upsert({ where: { scholarId: id }, create: { scholarId: id, optedOutAt: now, optOutConfirmed: true }, update: { optedOutAt: now, optOutConfirmed: true } });
      }
      return { ok: true, revokedAt: now };
    }
    const t = consentTexts[type];
    await prisma.consent.create({ data: { scholarId: id, type, textVersion: t.version, textSnapshot: t.text, channel: 'web-perfil', acceptedAt: now } });
    if (type === 'WHATSAPP') await prisma.conversation.upsert({ where: { scholarId: id }, create: { scholarId: id }, update: { optedOutAt: null, optOutConfirmed: false } });
    return { ok: true, acceptedAt: now };
  });

  /** El becario cuenta un evento de vida (duelo, salud, familia). Activa el perfil EVENTO_VIDA. */
  app.post('/scholar/life-event', async (req) => {
    const id = me(req);
    const { note } = z.object({ note: z.string().max(500) }).parse(req.body);
    const { now } = await currentWeek();
    await prisma.scholar.update({ where: { id }, data: { lifeEventReported: true } });
    await prisma.moodCheckin.create({ data: { scholarId: id, text: `Evento de vida: ${note}`, channel: 'web', createdAt: now } });
    const r = await recalcScholar(id, { source: 'EVENTO_VIDA' });
    return { ok: true, profiles: r.profiles };
  });
}
