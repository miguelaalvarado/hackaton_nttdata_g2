import {
  DEFAULT_MESSAGING_CONFIG,
  DEFAULT_PROFILE_THRESHOLDS,
  DEFAULT_SLA,
  type MessagingConfig,
  type ProfileThresholds,
  type RiskThresholds,
  type SlaConfig,
} from '@acompana/domain';
import { prisma } from '../index';

export interface ConsentText {
  version: string;
  text: string;
}

export interface FaqEntry {
  topic: string;
  keywords: string[];
  answer: string;
}

export interface AppSettings {
  riskThresholds: RiskThresholds;
  profileThresholds: ProfileThresholds;
  sla: SlaConfig;
  messaging: MessagingConfig;
  crisisHelpline: { text: string; source: string };
  /** Tasa de errores de límite/calidad (en 24 h) desde la que se alerta al coordinador. */
  errorRateAlertThreshold: number;
  maxSendAttempts: number;
  consentTexts: Record<'DATOS_LEY_29733' | 'WHATSAPP' | 'FAMILIA', ConsentText>;
  faq: FaqEntry[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  riskThresholds: { amarillo: 0.3, rojo: 0.55 },
  profileThresholds: DEFAULT_PROFILE_THRESHOLDS,
  sla: DEFAULT_SLA,
  messaging: DEFAULT_MESSAGING_CONFIG,
  crisisHelpline: {
    text:
      'Si sientes que estás en peligro, no estás solo/a: llama gratis a la Línea 113 Salud del MINSA (24 horas) y pide orientación en salud mental. Si es una emergencia, llama al 106 (SAMU).',
    source: 'https://www.gob.pe/555 (verificar antes de cada demo; configurable en AppConfig.crisisHelpline)',
  },
  errorRateAlertThreshold: 0.05,
  maxSendAttempts: 5,
  consentTexts: {
    DATOS_LEY_29733: {
      version: 'datos-v1',
      text:
        'Autorizo el tratamiento de mis datos personales (académicos, de asistencia y de bienestar) para que el programa me acompañe y prevenga riesgos en mis estudios, conforme a la Ley N.° 29733 de Protección de Datos Personales. Sé que puedo acceder, rectificar, cancelar u oponerme al tratamiento y retirar este consentimiento en cualquier momento desde mi perfil.',
    },
    WHATSAPP: {
      version: 'whatsapp-v1',
      text:
        'Acepto recibir mensajes por WhatsApp del programa (recordatorios de clases y trámites, check-ins de ánimo y mensajes de acompañamiento), como máximo uno al día iniciado por el programa y nunca entre las 22:00 y las 07:00. Puedo darme de baja en cualquier momento escribiendo BAJA.',
    },
    FAMILIA: {
      version: 'familia-v1',
      text:
        'Autorizo que el programa comparta con el familiar que indico solo información general de acompañamiento (no notas ni detalles de salud). Puedo retirar esta autorización cuando quiera.',
    },
  },
  faq: [
    {
      topic: 'Depósito de la subvención',
      keywords: ['deposit', 'subvencion', 'pago', 'plata', 'dinero'],
      answer:
        'Las fechas de depósito de tu subvención se publican en el portal del becario de Pronabec; en tu kit de llegada tienes el pendiente "Revisar fecha de depósito". (Contenido de demo: confirma siempre en los canales oficiales de Pronabec.)',
    },
    {
      topic: 'Constancia de estudios',
      keywords: ['constancia', 'certificado'],
      answer: 'La constancia de estudios se solicita en la oficina de registros académicos de tu universidad o en su plataforma virtual. (Contenido de demo.)',
    },
    {
      topic: 'Carné universitario y medio pasaje',
      keywords: ['carne', 'pasaje', 'transporte'],
      answer: 'El carné universitario lo tramita tu universidad; con él accedes al medio pasaje. Revisa el pendiente "Tramitar medio pasaje" en tu kit de llegada. (Contenido de demo.)',
    },
    {
      topic: 'Vivienda',
      keywords: ['vivienda', 'cuarto', 'alquiler', 'casa'],
      answer: 'Bienestar universitario suele tener una lista de alojamientos verificados y puede orientarte sobre contratos. Tu mentor también conoce la zona. (Contenido de demo.)',
    },
    {
      topic: 'Justificación de inasistencias',
      keywords: ['justific', 'falta', 'inasistencia'],
      answer: 'Las inasistencias se justifican ante tu facultad con el sustento (por ejemplo, constancia médica) dentro del plazo que fija tu universidad. Tu tutor puede ayudarte. (Contenido de demo.)',
    },
  ],
};

export async function getSettings(): Promise<AppSettings> {
  const rows = await prisma.appConfig.findMany();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<AppSettings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(s: Partial<AppSettings>): Promise<void> {
  for (const [key, value] of Object.entries(s)) {
    await prisma.appConfig.upsert({ where: { key }, create: { key, value: value as object }, update: { value: value as object } });
  }
}
