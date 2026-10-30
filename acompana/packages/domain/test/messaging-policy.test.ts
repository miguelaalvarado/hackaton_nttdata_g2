import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  detectCrisis,
  isQuietHours,
  isWindowOpen,
  parseInbound,
  policyGate,
  shouldRetry,
  validateTemplateCatalog,
  type ConversationState,
  type TemplateDef,
} from '../src';

const catalog: Record<string, TemplateDef> = {
  recordatorio_clase: {
    name: 'recordatorio_clase',
    language: 'es',
    category: 'UTILITY',
    status: 'APPROVED',
    linkedTo: 'CLASE',
    body: 'Hola {{1}}, tu clase de {{2}} empieza a las {{3}} en {{4}}.',
    endsWithQuestion: false,
  },
  checkin_semanal: {
    name: 'checkin_semanal',
    language: 'es',
    category: 'MARKETING',
    status: 'APPROVED',
    linkedTo: 'CHECKIN',
    body: 'Hola {{1}}, ¿cómo te sientes esta semana del 1 al 5?',
    endsWithQuestion: true,
  },
  pendiente: {
    name: 'pendiente',
    language: 'es',
    category: 'UTILITY',
    status: 'PENDING',
    linkedTo: 'TRAMITE',
    body: 'Tu trámite {{1}} vence el {{2}}.',
    endsWithQuestion: false,
  },
};

// 10:00 hora de Lima (UTC-5), lunes
const now = new Date('2026-10-26T15:00:00Z');
const h = (n: number) => n * 3600_000;
const open: ConversationState = { optIn: true, optedOutAt: null, lastInboundAt: new Date(now.getTime() - h(2)), platformSentAt: [], optOutConfirmed: false };
const closed: ConversationState = { ...open, lastInboundAt: new Date(now.getTime() - h(25)) };

describe('ventana de 24 horas', () => {
  it('abierta hasta 24 h después del último mensaje del becario', () => {
    expect(isWindowOpen(new Date(now.getTime() - h(23.9)), now)).toBe(true);
    expect(isWindowOpen(new Date(now.getTime() - h(24)), now)).toBe(false);
    expect(isWindowOpen(null, now)).toBe(false);
  });

  it('dentro de la ventana se permiten mensajes libres', () => {
    expect(policyGate({ initiator: 'REPLY', kind: 'FREE' }, open, catalog, now).decision).toBe('ALLOW');
  });

  it('fuera de la ventana solo plantillas aprobadas', () => {
    expect(policyGate({ initiator: 'REPLY', kind: 'FREE' }, closed, catalog, now)).toEqual({
      decision: 'REJECT',
      reason: 'FUERA_DE_VENTANA_REQUIERE_PLANTILLA',
    });
    expect(policyGate({ initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: 'recordatorio_clase' }, closed, catalog, now).decision).toBe('ALLOW');
    expect(policyGate({ initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: 'pendiente' }, closed, catalog, now)).toEqual({
      decision: 'REJECT',
      reason: 'PLANTILLA_NO_APROBADA',
    });
    expect(policyGate({ initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: 'no_existe' }, closed, catalog, now)).toMatchObject({
      reason: 'PLANTILLA_NO_EXISTE',
    });
  });
});

describe('opt-in / opt-out', () => {
  it('sin opt-in no se envía nada', () => {
    const r = policyGate({ initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: 'recordatorio_clase' }, { ...open, optIn: false }, catalog, now);
    expect(r).toEqual({ decision: 'REJECT', reason: 'SIN_OPT_IN' });
  });

  it('BAJA se reconoce con mayúsculas, tildes, espacios o signos', () => {
    for (const t of ['BAJA', 'baja', '  Bája ', 'baja.', '¡BAJA!']) expect(parseInbound(t)).toEqual({ type: 'OPT_OUT' });
    expect(parseInbound('quiero darme de baja del curso de física')).toMatchObject({ type: 'MESSAGE' });
    expect(parseInbound('ALTA')).toEqual({ type: 'OPT_IN' });
  });

  it('tras la baja se bloquea todo, incluso respuestas y mensajes humanos, salvo una única confirmación', () => {
    const out: ConversationState = { ...open, optedOutAt: now };
    for (const initiator of ['PLATFORM', 'REPLY', 'HUMAN', 'SAFETY'] as const) {
      expect(policyGate({ initiator, kind: 'FREE' }, out, catalog, now)).toEqual({ decision: 'REJECT', reason: 'BAJA_SOLICITADA' });
    }
    expect(policyGate({ initiator: 'OPT_OUT_CONFIRMATION', kind: 'FREE' }, out, catalog, now).decision).toBe('ALLOW');
    expect(policyGate({ initiator: 'OPT_OUT_CONFIRMATION', kind: 'FREE' }, { ...out, optOutConfirmed: true }, catalog, now).decision).toBe('REJECT');
  });
});

describe('límite de frecuencia y horario de silencio', () => {
  const tpl = { initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: 'recordatorio_clase' } as const;

  it('máximo 1 mensaje iniciado por la plataforma por día local (configurable)', () => {
    const sentToday: ConversationState = { ...closed, platformSentAt: [new Date(now.getTime() - h(1))] };
    const r = policyGate(tpl, sentToday, catalog, now);
    expect(r).toMatchObject({ decision: 'DEFER', reason: 'TOPE_DIARIO' });
    if (r.decision === 'DEFER') expect(r.until.toISOString()).toBe('2026-10-27T12:00:00.000Z'); // 07:00 Lima del día siguiente
    expect(policyGate(tpl, sentToday, catalog, now, { timeZone: 'America/Lima', dailyPlatformCap: 2, quietStartHour: 22, quietEndHour: 7, windowHours: 24 }).decision).toBe('ALLOW');
  });

  it('el envío de ayer (día local) no cuenta para hoy', () => {
    const yesterday: ConversationState = { ...closed, platformSentAt: [new Date('2026-10-26T04:30:00Z')] }; // 23:30 Lima del domingo
    expect(policyGate(tpl, yesterday, catalog, now).decision).toBe('ALLOW');
  });

  it('las respuestas al becario no consumen el tope', () => {
    const sentToday: ConversationState = { ...open, platformSentAt: [now] };
    expect(policyGate({ initiator: 'REPLY', kind: 'FREE' }, sentToday, catalog, now)).toMatchObject({ decision: 'ALLOW', countsTowardCap: false });
  });

  it('silencio de 22:00 a 07:00 hora de Lima', () => {
    expect(isQuietHours(new Date('2026-10-27T03:00:00Z'))).toBe(true); // 22:00 Lima
    expect(isQuietHours(new Date('2026-10-27T02:59:00Z'))).toBe(false); // 21:59 Lima
    expect(isQuietHours(new Date('2026-10-27T11:59:00Z'))).toBe(true); // 06:59 Lima
    expect(isQuietHours(new Date('2026-10-27T12:00:00Z'))).toBe(false); // 07:00 Lima
    const night = new Date('2026-10-27T04:00:00Z'); // 23:00 Lima
    const r = policyGate(tpl, closed, catalog, night);
    expect(r).toMatchObject({ decision: 'DEFER', reason: 'HORARIO_SILENCIO' });
    if (r.decision === 'DEFER') expect(r.until.toISOString()).toBe('2026-10-27T12:00:00.000Z');
  });

  it('la línea de ayuda ante crisis y las respuestas no se bloquean por horario', () => {
    const night = new Date('2026-10-27T04:00:00Z');
    const st: ConversationState = { ...open, lastInboundAt: new Date(night.getTime() - 60_000) };
    expect(policyGate({ initiator: 'SAFETY', kind: 'FREE' }, st, catalog, night).decision).toBe('ALLOW');
    expect(policyGate({ initiator: 'REPLY', kind: 'FREE' }, st, catalog, night).decision).toBe('ALLOW');
  });
});

describe('catálogo de plantillas', () => {
  it('el catálogo de ejemplo es válido', () => {
    expect(validateTemplateCatalog(catalog)).toEqual([]);
  });
  it('detecta promoción disfrazada de utility y check-ins sin pregunta', () => {
    const bad: Record<string, TemplateDef> = {
      motivacion: { ...catalog.recordatorio_clase, name: 'motivacion', linkedTo: null, body: '¡Tú puedes! Mensaje motivacional.' },
      checkin: { ...catalog.checkin_semanal, name: 'checkin', body: 'Cuéntanos cómo estás.', endsWithQuestion: false },
      clase_mkt: { ...catalog.recordatorio_clase, name: 'clase_mkt', category: 'MARKETING' },
    };
    const errors = validateTemplateCatalog(bad).join('\n');
    expect(errors).toMatch(/motivacion: UTILITY debe estar ligada/);
    expect(errors).toMatch(/motivacion: contenido promocional/);
    expect(errors).toMatch(/checkin: check-in debe terminar con pregunta/);
    expect(errors).toMatch(/clase_mkt: ligada a CLASE debe ser UTILITY/);
  });
});

describe('crisis y reintentos', () => {
  it('detecta lenguaje de crisis y de malestar', () => {
    expect(detectCrisis('Ya no puedo más, a veces pienso que sería mejor desaparecer').level).toBe('CRISIS');
    expect(detectCrisis('Me siento muy sola y no duermo').level).toBe('MALESTAR');
    expect(detectCrisis('¿Cuándo depositan la subvención?').level).toBe('NINGUNO');
  });

  it('solo reintenta errores transitorios, nunca rechazos por política', () => {
    expect(shouldRetry({ code: 'RATE_LIMIT', class: 'TRANSITORIO', message: '' }, 1, 5)).toBe(true);
    expect(shouldRetry({ code: 'RATE_LIMIT', class: 'TRANSITORIO', message: '' }, 5, 5)).toBe(false);
    expect(shouldRetry({ code: 'OUTSIDE_WINDOW', class: 'POLITICA', message: '' }, 1, 5)).toBe(false);
    expect(shouldRetry({ code: 'INVALID_NUMBER', class: 'PERMANENTE', message: '' }, 1, 5)).toBe(false);
  });

  it('backoff exponencial con tope', () => {
    expect([1, 2, 3, 4].map((a) => backoffDelayMs(a, 1000, 60_000))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelayMs(20, 1000, 60_000)).toBe(60_000);
  });
});
