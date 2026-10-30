import { backoffDelayMs, policyGate, shouldRetry, type ConversationState, type OutboundIntent } from '@acompana/domain';
import { renderTemplate, SimulatorChannel, TEMPLATE_CATALOG, type MessagingChannel, type StatusEvent } from '@acompana/messaging';
import { prisma, type MessageStatus } from '../index';
import { demoNow } from './clock';
import { getSettings } from './config';

/** Programador de reintentos/diferidos (pg-boss en api/worker). Sin programador, el mensaje queda PROGRAMADO en BD. */
export interface DeliveryScheduler {
  schedule(messageId: string, runAt: Date): Promise<void>;
}

let channel: MessagingChannel = new SimulatorChannel((e) => handleStatusEvent(e));
let scheduler: DeliveryScheduler | null = null;

export function configureMessaging(opts: { channel?: MessagingChannel; scheduler?: DeliveryScheduler | null }) {
  if (opts.channel) channel = opts.channel;
  if (opts.scheduler !== undefined) scheduler = opts.scheduler;
}

export async function getOrCreateConversation(scholarId: string) {
  return prisma.conversation.upsert({ where: { scholarId }, create: { scholarId }, update: {} });
}

/** Estado que necesita policyGate, leído de la BD. */
export async function conversationState(scholarId: string): Promise<ConversationState> {
  const conv = await getOrCreateConversation(scholarId);
  const consent = await prisma.consent.findFirst({
    where: { scholarId, type: 'WHATSAPP', revokedAt: null },
    orderBy: { acceptedAt: 'desc' },
  });
  const since = new Date(Date.now() - 3 * 86_400_000 - 30 * 86_400_000); // margen amplio por el reloj de demo
  const sent = await prisma.message.findMany({
    where: { conversationId: conv.id, initiator: 'PLATFORM', status: { in: ['ENVIADO', 'ENTREGADO', 'LEIDO'] }, sentAt: { gte: since } },
    select: { sentAt: true },
  });
  return {
    optIn: Boolean(consent),
    optedOutAt: conv.optedOutAt,
    lastInboundAt: conv.lastInboundAt,
    platformSentAt: sent.map((m) => m.sentAt!),
    optOutConfirmed: conv.optOutConfirmed,
  };
}

export interface OutboundRequest {
  scholarId: string;
  intent: OutboundIntent;
  text?: string;
  templateParams?: string[];
}

/** Crea el mensaje y lo intenta entregar de inmediato (pasando siempre por policyGate). */
export async function sendToScholar(req: OutboundRequest) {
  const conv = await getOrCreateConversation(req.scholarId);
  const tpl = req.intent.templateName ? TEMPLATE_CATALOG[req.intent.templateName] : undefined;
  const body = req.intent.kind === 'TEMPLATE' && tpl ? renderTemplate(tpl, req.templateParams ?? []) : (req.text ?? '');
  const msg = await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: 'OUT',
      initiator: req.intent.initiator,
      kind: req.intent.kind,
      templateName: req.intent.templateName,
      templateParams: req.templateParams ?? [],
      category: tpl?.category,
      body,
      status: 'PROGRAMADO',
      channel: channel.name,
      createdAt: await demoNow(),
    },
  });
  return deliverMessage(msg.id);
}

/**
 * Entrega un mensaje: re-evalúa políticas (pudo llegar una BAJA mientras esperaba), envía y clasifica errores.
 * Transitorio → reintento con backoff exponencial. Política/permanente → FALLIDO, nunca se reintenta.
 */
export async function deliverMessage(messageId: string) {
  const settings = await getSettings();
  const msg = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: { conversation: true } });
  if (msg.status !== 'PROGRAMADO') return msg;
  const now = await demoNow();
  const state = await conversationState(msg.conversation.scholarId);
  const intent: OutboundIntent = {
    initiator: msg.initiator as OutboundIntent['initiator'],
    kind: msg.kind as OutboundIntent['kind'],
    templateName: msg.templateName ?? undefined,
  };
  const decision = policyGate(intent, state, TEMPLATE_CATALOG, now, settings.messaging);

  if (decision.decision === 'REJECT') {
    return prisma.message.update({ where: { id: msg.id }, data: { status: 'BLOQUEADO', policyDecision: decision.reason } });
  }
  if (decision.decision === 'DEFER') {
    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: { policyDecision: decision.reason, scheduledFor: decision.until },
    });
    await scheduler?.schedule(msg.id, decision.until);
    return updated;
  }

  const scholar = await prisma.scholar.findUniqueOrThrow({ where: { id: msg.conversation.scholarId } });
  const tpl = msg.templateName ? TEMPLATE_CATALOG[msg.templateName] : undefined;
  const attempts = msg.attempts + 1;
  const result = await channel.send({
    clientRef: msg.id,
    to: channel.name === 'simulator' ? scholar.id : scholar.phoneE164,
    kind: intent.kind,
    text: intent.kind === 'FREE' ? msg.body : undefined,
    template: tpl ? { name: tpl.name, language: tpl.language, params: msg.templateParams } : undefined,
  });

  if (result.ok) {
    if (msg.initiator === 'OPT_OUT_CONFIRMATION') {
      await prisma.conversation.update({ where: { id: msg.conversationId }, data: { optOutConfirmed: true } });
    }
    return prisma.message.update({
      where: { id: msg.id },
      data: { status: 'ENVIADO', providerMessageId: result.providerMessageId, sentAt: now, attempts, policyDecision: 'ALLOW', errorCode: null },
    });
  }

  await prisma.messageEvent.create({ data: { messageId: msg.id, status: 'failed', errorCode: result.error.code, raw: { message: result.error.message } } });
  if (shouldRetry(result.error, attempts, settings.maxSendAttempts)) {
    const runAt = new Date(now.getTime() + backoffDelayMs(attempts));
    await prisma.message.update({
      where: { id: msg.id },
      data: { attempts, errorCode: result.error.code, errorClass: result.error.class, scheduledFor: runAt },
    });
    await scheduler?.schedule(msg.id, runAt);
    return prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
  }
  return prisma.message.update({
    where: { id: msg.id },
    data: { status: 'FALLIDO', attempts, errorCode: result.error.code, errorClass: result.error.class },
  });
}

const STATUS_MAP: Record<StatusEvent['status'], MessageStatus> = {
  sent: 'ENVIADO',
  delivered: 'ENTREGADO',
  read: 'LEIDO',
  failed: 'FALLIDO',
};
const ORDER: MessageStatus[] = ['PROGRAMADO', 'ENVIADO', 'ENTREGADO', 'LEIDO'];

/** Webhook de estados (entregado, leído, fallido). Nunca retrocede un estado. */
export async function handleStatusEvent(e: StatusEvent) {
  const msg = await prisma.message.findUnique({ where: { providerMessageId: e.providerMessageId } });
  await prisma.messageEvent.create({
    data: { messageId: msg?.id, providerMessageId: e.providerMessageId, status: e.status, errorCode: e.error?.code, at: e.at },
  });
  if (!msg) return;
  const next = STATUS_MAP[e.status];
  if (next === 'FALLIDO' || ORDER.indexOf(next) > ORDER.indexOf(msg.status)) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: next, ...(e.error ? { errorCode: e.error.code, errorClass: e.error.class } : {}) },
    });
  }
}
