import { localDayKey, zonedParts, zonedTimeToUtc } from './time';

export type TemplateCategory = 'UTILITY' | 'MARKETING';

export interface TemplateDef {
  name: string;
  language: string;
  category: TemplateCategory;
  /** Estado de aprobación en Meta/AWS. Solo APPROVED se puede enviar. */
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  /** A qué evento concreto está ligada (clase, trámite). Obligatorio en UTILITY. */
  linkedTo: 'CLASE' | 'TRAMITE' | 'CHECKIN' | 'ALERTA' | null;
  /** Texto con variables {{1}}, {{2}}… */
  body: string;
  /** Termina en pregunta (requerido para check-ins: la respuesta reabre la ventana). */
  endsWithQuestion: boolean;
}

export interface MessagingConfig {
  timeZone: string;
  /** Máximo de mensajes iniciados por la plataforma por becario y día local. */
  dailyPlatformCap: number;
  quietStartHour: number; // 22
  quietEndHour: number; // 7
  windowHours: number; // 24
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  timeZone: 'America/Lima',
  dailyPlatformCap: 1,
  quietStartHour: 22,
  quietEndHour: 7,
  windowHours: 24,
};

/**
 * Quién origina el mensaje:
 * - PLATFORM: recordatorios, pastillas, check-ins programados (cuentan para el tope y respetan el silencio).
 * - REPLY: respuesta del asistente a un mensaje del becario.
 * - HUMAN: mensaje escrito por mentor/tutor/coordinador.
 * - SAFETY: línea de ayuda ante crisis.
 * - OPT_OUT_CONFIRMATION: confirmación única de la baja.
 */
export type Initiator = 'PLATFORM' | 'REPLY' | 'HUMAN' | 'SAFETY' | 'OPT_OUT_CONFIRMATION';

export interface OutboundIntent {
  initiator: Initiator;
  kind: 'FREE' | 'TEMPLATE';
  templateName?: string;
}

export interface ConversationState {
  /** Consentimiento de WhatsApp vigente (aceptado y no revocado). */
  optIn: boolean;
  optedOutAt: Date | null;
  lastInboundAt: Date | null;
  /** Fecha/hora de los mensajes ya enviados por la plataforma (iniciados por PLATFORM). */
  platformSentAt: Date[];
  /** Si ya se envió la confirmación de la baja vigente. */
  optOutConfirmed: boolean;
}

export type RejectReason =
  | 'SIN_OPT_IN'
  | 'BAJA_SOLICITADA'
  | 'FUERA_DE_VENTANA_REQUIERE_PLANTILLA'
  | 'PLANTILLA_NO_EXISTE'
  | 'PLANTILLA_NO_APROBADA';

export type DeferReason = 'HORARIO_SILENCIO' | 'TOPE_DIARIO';

export type PolicyDecision =
  | { decision: 'ALLOW'; countsTowardCap: boolean; windowOpen: boolean }
  | { decision: 'DEFER'; reason: DeferReason; until: Date }
  | { decision: 'REJECT'; reason: RejectReason };

export function isWindowOpen(lastInboundAt: Date | null, now: Date, cfg: MessagingConfig = DEFAULT_MESSAGING_CONFIG): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < cfg.windowHours * 3600_000 && now >= lastInboundAt;
}

export function isQuietHours(now: Date, cfg: MessagingConfig = DEFAULT_MESSAGING_CONFIG): boolean {
  const { hour } = zonedParts(now, cfg.timeZone);
  return cfg.quietStartHour > cfg.quietEndHour
    ? hour >= cfg.quietStartHour || hour < cfg.quietEndHour
    : hour >= cfg.quietStartHour && hour < cfg.quietEndHour;
}

/** Próximo fin del horario de silencio (p. ej. 07:00 Lima). */
export function nextQuietEnd(now: Date, cfg: MessagingConfig = DEFAULT_MESSAGING_CONFIG): Date {
  const p = zonedParts(now, cfg.timeZone);
  const today = zonedTimeToUtc(p.year, p.month, p.day, cfg.quietEndHour, cfg.timeZone);
  return today > now ? today : zonedTimeToUtc(p.year, p.month, p.day + 1, cfg.quietEndHour, cfg.timeZone);
}

export function platformSentToday(sentAt: Date[], now: Date, cfg: MessagingConfig = DEFAULT_MESSAGING_CONFIG): number {
  const today = localDayKey(now, cfg.timeZone);
  return sentAt.filter((d) => localDayKey(d, cfg.timeZone) === today).length;
}

/**
 * Puerta única de políticas de WhatsApp. Ningún canal envía sin pasar por aquí.
 * Orden: consentimiento → baja → ventana 24 h / plantilla → silencio y tope (solo iniciados por la plataforma).
 */
export function policyGate(
  intent: OutboundIntent,
  state: ConversationState,
  catalog: Record<string, TemplateDef>,
  now: Date,
  cfg: MessagingConfig = DEFAULT_MESSAGING_CONFIG,
): PolicyDecision {
  if (intent.initiator === 'OPT_OUT_CONFIRMATION') {
    if (!state.optedOutAt) return { decision: 'REJECT', reason: 'SIN_OPT_IN' };
    if (state.optOutConfirmed) return { decision: 'REJECT', reason: 'BAJA_SOLICITADA' };
    return { decision: 'ALLOW', countsTowardCap: false, windowOpen: isWindowOpen(state.lastInboundAt, now, cfg) };
  }
  if (state.optedOutAt) return { decision: 'REJECT', reason: 'BAJA_SOLICITADA' };
  if (!state.optIn) return { decision: 'REJECT', reason: 'SIN_OPT_IN' };

  const windowOpen = isWindowOpen(state.lastInboundAt, now, cfg);
  if (intent.kind === 'TEMPLATE') {
    const t = intent.templateName ? catalog[intent.templateName] : undefined;
    if (!t) return { decision: 'REJECT', reason: 'PLANTILLA_NO_EXISTE' };
    if (t.status !== 'APPROVED') return { decision: 'REJECT', reason: 'PLANTILLA_NO_APROBADA' };
  } else if (!windowOpen) {
    return { decision: 'REJECT', reason: 'FUERA_DE_VENTANA_REQUIERE_PLANTILLA' };
  }

  if (intent.initiator === 'PLATFORM') {
    if (isQuietHours(now, cfg)) return { decision: 'DEFER', reason: 'HORARIO_SILENCIO', until: nextQuietEnd(now, cfg) };
    if (platformSentToday(state.platformSentAt, now, cfg) >= cfg.dailyPlatformCap) {
      const p = zonedParts(now, cfg.timeZone);
      return {
        decision: 'DEFER',
        reason: 'TOPE_DIARIO',
        until: zonedTimeToUtc(p.year, p.month, p.day + 1, cfg.quietEndHour, cfg.timeZone),
      };
    }
    return { decision: 'ALLOW', countsTowardCap: true, windowOpen };
  }
  return { decision: 'ALLOW', countsTowardCap: false, windowOpen };
}

/**
 * Validación del catálogo de plantillas:
 * - Las ligadas a una clase o trámite concreto son UTILITY.
 * - Una UTILITY debe estar ligada a una clase, trámite o cita concreta (nada promocional disfrazado de utility).
 * - Los check-ins terminan con pregunta.
 */
export function validateTemplateCatalog(catalog: Record<string, TemplateDef>): string[] {
  const errors: string[] = [];
  for (const [key, t] of Object.entries(catalog)) {
    if (key !== t.name) errors.push(`${key}: la clave no coincide con el nombre`);
    if ((t.linkedTo === 'CLASE' || t.linkedTo === 'TRAMITE') && t.category !== 'UTILITY') {
      errors.push(`${t.name}: ligada a ${t.linkedTo} debe ser UTILITY`);
    }
    if (t.category === 'UTILITY' && (t.linkedTo === null || t.linkedTo === 'CHECKIN')) {
      // Criterio conservador: un check-in programado no responde a una acción concreta del becario.
      errors.push(`${t.name}: UTILITY debe estar ligada a una clase, trámite o cita concreta`);
    }
    if (t.category === 'UTILITY' && /motiva|ánimo|tú puedes|inspira|promo|descuento/i.test(t.body)) {
      errors.push(`${t.name}: contenido promocional/motivacional no puede ser UTILITY`);
    }
    if (t.linkedTo === 'CHECKIN' && !t.body.trim().endsWith('?')) errors.push(`${t.name}: check-in debe terminar con pregunta`);
    if (t.endsWithQuestion !== t.body.trim().endsWith('?')) errors.push(`${t.name}: endsWithQuestion no coincide con el texto`);
  }
  return errors;
}
