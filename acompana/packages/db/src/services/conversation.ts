import { addHours, detectCrisis, parseInbound } from '@acompana/domain';
import { ASSISTANT_SYSTEM_PROMPT, ASSISTANT_TOOLS, createLLMProvider, type ChatTurn, type LLMProvider } from '@acompana/llm';
import { prisma } from '../index';
import { makeToolRunner, type ToolEffects } from './assistant-tools';
import { currentWeek, demoNow } from './clock';
import { getSettings } from './config';
import { getOrCreateConversation, sendToScholar } from './outbound';
import { recalcScholar, resolveAssignee } from './recalc';

let provider: LLMProvider | null = null;
export function getProvider(): LLMProvider {
  provider ??= createLLMProvider();
  return provider;
}
export function setProvider(p: LLMProvider) {
  provider = p;
}

export type InboundOutcome = 'OPT_OUT' | 'OPT_IN' | 'CRISIS_ESCALADA' | 'RESPUESTA' | 'SIN_RESPUESTA_POR_BAJA';

/**
 * Pipeline de un mensaje entrante del becario:
 * BAJA/ALTA → (si está de baja, no se responde) → detección de crisis (antes del LLM) → asistente → policyGate → canal.
 */
export async function handleInbound(scholarId: string, text: string, channel = 'simulator'): Promise<{ outcome: InboundOutcome }> {
  const now = await demoNow();
  const conv = await getOrCreateConversation(scholarId);
  await prisma.message.create({
    data: { conversationId: conv.id, direction: 'IN', initiator: 'SCHOLAR', kind: 'FREE', body: text, status: 'RECIBIDO', channel, createdAt: now },
  });
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: now } });

  const cmd = parseInbound(text);
  if (cmd.type === 'OPT_OUT') {
    await prisma.conversation.update({ where: { id: conv.id }, data: { optedOutAt: now, optOutConfirmed: false } });
    await prisma.consent.updateMany({ where: { scholarId, type: 'WHATSAPP', revokedAt: null }, data: { revokedAt: now } });
    await sendToScholar({
      scholarId,
      intent: { initiator: 'OPT_OUT_CONFIRMATION', kind: 'FREE' },
      text: 'Listo, ya no recibirás mensajes de Acompaña por WhatsApp. Si cambias de opinión, escribe ALTA.',
    });
    return { outcome: 'OPT_OUT' };
  }
  if (cmd.type === 'OPT_IN') {
    const { consentTexts } = await getSettings();
    await prisma.consent.create({
      data: {
        scholarId,
        type: 'WHATSAPP',
        textVersion: consentTexts.WHATSAPP.version,
        textSnapshot: consentTexts.WHATSAPP.text,
        channel: `${channel}:ALTA`,
        acceptedAt: now,
      },
    });
    await prisma.conversation.update({ where: { id: conv.id }, data: { optedOutAt: null, optOutConfirmed: false } });
    await sendToScholar({
      scholarId,
      intent: { initiator: 'REPLY', kind: 'FREE' },
      text: '¡Qué bueno tenerte de vuelta! Volverás a recibir recordatorios y check-ins. ¿En qué te ayudo hoy?',
    });
    return { outcome: 'OPT_IN' };
  }

  const crisis = detectCrisis(text);
  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });

  if (crisis.level === 'CRISIS') {
    // No se responde con el LLM: se escala de inmediato a una persona y se muestra la línea de ayuda.
    await prisma.moodCheckin.create({ data: { scholarId, text, channel, level: 'CRISIS', createdAt: now } });
    await recalcScholar(scholarId, { source: 'CRISIS_CHAT' });
    if (fresh.optedOutAt) return { outcome: 'CRISIS_ESCALADA' }; // el equipo contacta por otro medio
    const { crisisHelpline } = await getSettings();
    const psych = await prisma.alert.findFirst({
      where: { scholarId, profile: 'MALESTAR_EMOCIONAL', direction: 'TEAM', status: { not: 'CERRADA' } },
      include: { assignee: true },
      orderBy: { createdAt: 'desc' },
    });
    const who = psych?.assignee?.name ? `${psych.assignee.name}, psicóloga de tu universidad,` : 'una persona del equipo de psicología';
    await sendToScholar({
      scholarId,
      intent: { initiator: 'SAFETY', kind: 'FREE' },
      text: `Gracias por contármelo; me importa lo que te pasa y no tienes que pasarlo solo/a. Ya avisé a ${who} para que te contacte hoy mismo. ${crisisHelpline.text} ¿Estás en un lugar seguro en este momento?`,
    });
    return { outcome: 'CRISIS_ESCALADA' };
  }

  if (crisis.level === 'MALESTAR') {
    await prisma.moodCheckin.create({ data: { scholarId, text, channel, level: 'MALESTAR', createdAt: now } });
  }
  if (fresh.optedOutAt) {
    if (crisis.level === 'MALESTAR') await recalcScholar(scholarId, { source: 'MALESTAR_CHAT' });
    return { outcome: 'SIN_RESPUESTA_POR_BAJA' };
  }

  const history = await prisma.message.findMany({
    where: { conversationId: conv.id, status: { not: 'BLOQUEADO' } },
    orderBy: { createdAt: 'desc' },
    take: 12,
  });
  const turns: ChatTurn[] = history
    .reverse()
    .map((m) => ({ role: m.direction === 'IN' ? ('user' as const) : ('assistant' as const), text: m.body }));
  while (turns.length && turns[0].role !== 'user') turns.shift();

  const effects: ToolEffects = { humanRequested: null, moodLogged: null };
  const reply = await getProvider().reply({
    system: ASSISTANT_SYSTEM_PROMPT,
    history: turns,
    tools: ASSISTANT_TOOLS,
    runTool: makeToolRunner(scholarId, effects),
  });

  if (crisis.level === 'MALESTAR' || effects.moodLogged !== null) {
    await recalcScholar(scholarId, { source: crisis.level === 'MALESTAR' ? 'MALESTAR_CHAT' : 'CHECKIN' });
  }
  if (effects.humanRequested && effects.humanRequested.team !== 'PSICOLOGIA') {
    await createRequestAlert(scholarId, effects.humanRequested.team, effects.humanRequested.reason);
  } else if (effects.humanRequested && crisis.level === 'NINGUNO') {
    await createRequestAlert(scholarId, 'PSICOLOGIA', effects.humanRequested.reason);
  }

  await sendToScholar({ scholarId, intent: { initiator: 'REPLY', kind: 'FREE' }, text: reply.text });
  return { outcome: 'RESPUESTA' };
}

/** Alerta amarilla cuando el becario (o el asistente) pide una persona. */
async function createRequestAlert(scholarId: string, team: string, reason: string) {
  const { weekStart, now } = await currentWeek();
  const { sla } = await getSettings();
  const s = await prisma.scholar.findUniqueOrThrow({ where: { id: scholarId } });
  const owner =
    team === 'PSICOLOGIA'
      ? ({ role: 'TUTOR', specialty: 'PSICOLOGIA' } as const)
      : team === 'TUTOR_ACADEMICO'
        ? ({ role: 'TUTOR', specialty: 'ACADEMICO' } as const)
        : team === 'MENTOR'
          ? ({ role: 'MENTOR' } as const)
          : ({ role: 'COORDINADOR' } as const);
  const dedupeKey = `${scholarId}:SOLICITUD_${team}:${weekStart}:TEAM`;
  if (await prisma.alert.findUnique({ where: { dedupeKey } })) return;
  await prisma.alert.create({
    data: {
      dedupeKey,
      scholarId,
      direction: 'TEAM',
      severity: 'AMARILLO',
      profile: team === 'PSICOLOGIA' ? 'MALESTAR_EMOCIONAL' : 'ESTABLE',
      reason: `Solicitud desde el chat: ${reason}`,
      nextStep: 'Contactar al becario para atender su consulta.',
      assigneeId: await resolveAssignee(owner, scholarId, s.universityId),
      dueAt: addHours(now, sla.hoursBySeverity.AMARILLO),
      source: 'CHAT',
      createdAt: now,
    },
  });
}
