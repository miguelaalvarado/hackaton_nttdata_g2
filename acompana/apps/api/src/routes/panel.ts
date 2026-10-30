import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { riskModel, slaStatus, type LogisticModel } from '@acompana/domain';
import { prisma, type Prisma } from '@acompana/db';
import {
  addAlertAction,
  advanceDemoWeek,
  currentWeek,
  recalcAll,
  recalcScholar,
  rulesStatus,
  sendToScholar,
} from '@acompana/db/services';
import { TEMPLATE_CATALOG } from '@acompana/messaging';
import { assertCanSee, HttpError, requireRole, scholarScope, type AuthUser } from '../auth';

/** Últimos snapshots (semana actual) de riesgo y perfil por becario. */
async function latestSnapshots(scholarIds: string[]) {
  const [risks, profiles] = await Promise.all([
    prisma.riskSnapshot.findMany({ where: { scholarId: { in: scholarIds } }, orderBy: { createdAt: 'desc' }, distinct: ['scholarId'] }),
    prisma.profileSnapshot.findMany({ where: { scholarId: { in: scholarIds } }, orderBy: { createdAt: 'desc' }, distinct: ['scholarId'] }),
  ]);
  return { risk: new Map(risks.map((r) => [r.scholarId, r])), profile: new Map(profiles.map((p) => [p.scholarId, p])) };
}

function alertScope(u: AuthUser): Prisma.AlertWhereInput {
  return { scholar: scholarScope(u), direction: 'TEAM' };
}

export async function panelRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireRole('COORDINADOR', 'TUTOR', 'MENTOR'));

  app.get('/panel/overview', async (req) => {
    const u = req.user;
    const { now, weekStart, weekNumber } = await currentWeek();
    const scholars = await prisma.scholar.findMany({ where: scholarScope(u), select: { id: true } });
    const ids = scholars.map((s) => s.id);
    const snap = await latestSnapshots(ids);

    const byColor: Record<string, number> = { VERDE: 0, AMARILLO: 0, ROJO: 0, SIN_DATOS: 0 };
    const byProfile: Record<string, number> = {};
    for (const id of ids) {
      byColor[snap.risk.get(id)?.color ?? 'SIN_DATOS']++;
      for (const p of snap.profile.get(id)?.profiles ?? []) byProfile[p] = (byProfile[p] ?? 0) + 1;
    }

    const alerts = await prisma.alert.findMany({ where: alertScope(u), select: { severity: true, status: true, dueAt: true, firstActionAt: true, createdAt: true } });
    const open = alerts.filter((a) => a.status !== 'CERRADA');
    const reds = alerts.filter((a) => a.severity === 'ROJO');
    const sla = { CUMPLIDA: 0, INCUMPLIDA: 0, EN_PLAZO: 0, VENCIDA: 0, SIN_SLA: 0 };
    for (const a of reds) sla[slaStatus(a, now)]++;
    const decided = sla.CUMPLIDA + sla.INCUMPLIDA + sla.VENCIDA;
    const firstActionHours = reds
      .filter((a) => a.firstActionAt)
      .map((a) => (a.firstActionAt!.getTime() - a.createdAt.getTime()) / 3600_000);

    const msgs = await prisma.message.groupBy({
      by: ['status', 'policyDecision'],
      where: { direction: 'OUT', conversation: { scholar: scholarScope(u) } },
      _count: true,
    });

    return {
      week: { weekStart, weekNumber, now },
      scholars: ids.length,
      byColor,
      byProfile,
      alerts: {
        open: open.length,
        openRed: open.filter((a) => a.severity === 'ROJO').length,
        openYellow: open.filter((a) => a.severity === 'AMARILLO').length,
      },
      sla48: {
        ...sla,
        complianceRate: decided ? sla.CUMPLIDA / decided : null,
        avgHoursToFirstAction: firstActionHours.length ? firstActionHours.reduce((a, b) => a + b, 0) / firstActionHours.length : null,
      },
      messaging: msgs.map((m) => ({ status: m.status, policyDecision: m.policyDecision, count: m._count })),
      model: { version: (riskModel as LogisticModel).version, metrics: (riskModel as LogisticModel).metrics, note: 'Entrenado con datos sintéticos: mide recuperación de patrones plantados, no desempeño real.' },
    };
  });

  app.get('/panel/scholars', async (req) => {
    const q = z
      .object({ color: z.string().optional(), profile: z.string().optional(), q: z.string().optional(), universityId: z.string().optional() })
      .parse(req.query);
    const where: Prisma.ScholarWhereInput = {
      ...scholarScope(req.user),
      ...(q.universityId ? { universityId: q.universityId } : {}),
      ...(q.q ? { user: { name: { contains: q.q, mode: 'insensitive' } } } : {}),
    };
    const scholars = await prisma.scholar.findMany({
      where,
      include: {
        user: { select: { name: true } },
        university: { select: { name: true } },
        career: { select: { name: true } },
        ruleSet: { select: { code: true } },
        alerts: { where: { direction: 'TEAM', status: { not: 'CERRADA' } }, select: { severity: true } },
      },
    });
    const snap = await latestSnapshots(scholars.map((s) => s.id));
    const rank = { ROJO: 0, AMARILLO: 1, VERDE: 2, SIN_DATOS: 3 } as const;
    return scholars
      .map((s) => {
        const r = snap.risk.get(s.id);
        const p = snap.profile.get(s.id);
        return {
          id: s.id,
          name: s.user.name,
          persona: s.persona !== 'sintético' ? s.persona : null,
          university: s.university.name,
          career: s.career.name,
          cohort: s.ruleSet.code,
          color: (r?.color ?? 'SIN_DATOS') as keyof typeof rank,
          probability: r?.probability ?? null,
          topReason: (r?.reasons as { text: string; direction: string }[] | undefined)?.find((x) => x.direction === 'SUBE')?.text ?? null,
          profiles: p?.profiles ?? [],
          openAlerts: s.alerts.length,
        };
      })
      .filter((s) => (!q.color || s.color === q.color) && (!q.profile || s.profiles.includes(q.profile)))
      .sort((a, b) => rank[a.color] - rank[b.color] || (b.probability ?? 0) - (a.probability ?? 0));
  });

  app.get('/panel/scholars/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertCanSee(req.user, id);
    const { now } = await currentWeek();
    const s = await prisma.scholar.findUniqueOrThrow({
      where: { id },
      include: {
        user: true,
        university: true,
        career: true,
        ruleSet: true,
        originRegion: true,
        onboarding: true,
        consents: { orderBy: { acceptedAt: 'desc' } },
        signals: { orderBy: { weekStart: 'asc' } },
        risks: { orderBy: { createdAt: 'asc' } },
        profiles: { orderBy: { createdAt: 'asc' } },
        mentors: { where: { active: true }, include: { mentor: { select: { name: true } } } },
        checklist: { include: { item: true } },
        studyPlans: { orderBy: { weekStart: 'desc' }, take: 1, include: { blocks: true } },
        alerts: {
          orderBy: { createdAt: 'desc' },
          include: { assignee: { select: { name: true, role: true, specialty: true } }, actions: { include: { actor: { select: { name: true } } }, orderBy: { at: 'asc' } } },
        },
      },
    });
    // Datos de salud/bienestar: el mentor no ve el detalle emocional (mínimo necesario).
    const hideEmotional = req.user.role === 'MENTOR';
    return {
      id: s.id,
      name: s.user.name,
      persona: s.persona !== 'sintético' ? s.persona : null,
      university: s.university.name,
      career: s.career.name,
      origin: s.originRegion.name,
      livesAlone: s.livesAlone,
      cohort: { code: s.ruleSet.code, name: s.ruleSet.name, legalRef: s.ruleSet.legalRef },
      onboarding: s.onboarding,
      consents: s.consents.map((c) => ({ type: c.type, textVersion: c.textVersion, acceptedAt: c.acceptedAt, revokedAt: c.revokedAt, channel: c.channel })),
      mentor: s.mentors[0] ? { name: s.mentors[0].mentor.name, reason: s.mentors[0].reason } : null,
      checklist: { total: s.checklist.length, overdue: s.checklist.filter((c) => !c.doneAt && c.dueDate < now).map((c) => c.item.title) },
      signals: s.signals.map((x) => ({ ...x, mood: hideEmotional ? null : x.mood })),
      risks: s.risks.map((r) => ({ weekStart: r.weekStart, color: r.color, probability: r.probability, reasons: r.reasons, rulesFired: r.rulesFired })),
      profiles: s.profiles.map((p) => ({ weekStart: p.weekStart, profiles: p.profiles, primary: p.primary, evidence: p.evidence })),
      rules: await rulesStatus(id),
      studyPlan: s.studyPlans[0]
        ? {
            weekStart: s.studyPlans[0].weekStart,
            priorities: s.studyPlans[0].priorities,
            blocksTotal: s.studyPlans[0].blocks.length,
            blocksDone: s.studyPlans[0].blocks.filter((b) => b.doneAt).length,
            minutesPlanned: s.studyPlans[0].blocks.reduce((a, b) => a + b.minutes, 0),
            minutesDone: s.studyPlans[0].blocks.filter((b) => b.doneAt).reduce((a, b) => a + b.minutes, 0),
          }
        : null,
      alerts: s.alerts
        .filter((a) => !hideEmotional || a.profile !== 'MALESTAR_EMOCIONAL')
        .map((a) => ({ ...a, sla: slaStatus(a, now) })),
    };
  });

  app.get('/panel/alerts', async (req) => {
    const q = z.object({ mine: z.coerce.boolean().optional(), status: z.enum(['abiertas', 'todas']).optional() }).parse(req.query);
    const { now } = await currentWeek();
    const alerts = await prisma.alert.findMany({
      where: {
        ...alertScope(req.user),
        ...(q.status !== 'todas' ? { status: { not: 'CERRADA' } } : {}),
        ...(q.mine || req.user.role !== 'COORDINADOR' ? { assigneeId: req.user.sub } : {}),
      },
      include: { scholar: { include: { user: { select: { name: true } }, university: { select: { name: true } } } }, assignee: { select: { name: true } }, actions: { select: { id: true } } },
      orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }],
    });
    return alerts.map((a) => ({
      id: a.id,
      scholarId: a.scholarId,
      scholarName: a.scholar.user.name,
      university: a.scholar.university.name,
      severity: a.severity,
      profile: a.profile,
      reason: a.reason,
      nextStep: a.nextStep,
      assignee: a.assignee?.name ?? null,
      status: a.status,
      source: a.source,
      createdAt: a.createdAt,
      dueAt: a.dueAt,
      sla: slaStatus(a, now),
      actions: a.actions.length,
    }));
  });

  app.post('/panel/alerts/:id/actions', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ type: z.enum(['CONTACTO', 'DERIVACION', 'SESION', 'NOTA', 'CIERRE']), note: z.string().trim().min(3).max(1000) }).parse(req.body);
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id } });
    await assertCanSee(req.user, alert.scholarId);
    if (req.user.role !== 'COORDINADOR' && alert.assigneeId !== req.user.sub) {
      throw new HttpError(403, 'NO_ES_RESPONSABLE', 'Solo el responsable asignado o un coordinador puede registrar acciones.');
    }
    await addAlertAction(id, req.user.sub, body.type, body.note);
    return prisma.alert.findUniqueOrThrow({ where: { id }, include: { actions: true } });
  });

  app.post('/panel/alerts/:id/assign', { preHandler: requireRole('COORDINADOR') }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id } });
    await assertCanSee(req.user, alert.scholarId);
    return prisma.alert.update({ where: { id }, data: { assigneeId: userId } });
  });

  app.get('/panel/staff', async (req) => {
    const where: Prisma.UserWhereInput = { role: { in: ['TUTOR', 'MENTOR', 'COORDINADOR'] }, ...(req.user.universityId ? { universityId: req.user.universityId } : {}) };
    return prisma.user.findMany({ where, select: { id: true, name: true, role: true, specialty: true, universityId: true }, orderBy: { name: 'asc' } });
  });

  app.get('/panel/templates', async () => Object.values(TEMPLATE_CATALOG));

  /** Enviar un mensaje al becario: plantilla de la plataforma o texto de una persona. Siempre pasa por policyGate. */
  app.post('/panel/scholars/:id/message', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertCanSee(req.user, id);
    const body = z
      .object({ kind: z.enum(['TEMPLATE', 'FREE']), templateName: z.string().optional(), params: z.array(z.string()).optional(), text: z.string().max(1000).optional() })
      .parse(req.body);
    const msg = await sendToScholar({
      scholarId: id,
      intent: body.kind === 'TEMPLATE' ? { initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: body.templateName } : { initiator: 'HUMAN', kind: 'FREE' },
      text: body.text,
      templateParams: body.params,
    });
    return { id: msg.id, status: msg.status, policyDecision: msg.policyDecision, scheduledFor: msg.scheduledFor, errorCode: msg.errorCode, body: msg.body };
  });

  app.post('/panel/scholars/:id/recalculate', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertCanSee(req.user, id);
    return recalcScholar(id, { source: 'MANUAL' });
  });

  // Solo demo
  app.post('/panel/recalculate', { preHandler: requireRole('COORDINADOR') }, async () => recalcAll());
  app.post('/panel/demo/advance-week', { preHandler: requireRole('COORDINADOR') }, async () => advanceDemoWeek());
}
