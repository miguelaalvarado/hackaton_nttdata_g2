import type { TemplateDef } from '@acompana/domain';

/**
 * Catálogo de plantillas (fuente de verdad en código). Deben registrarse y aprobarse en WhatsApp Manager / AWS con el mismo nombre.
 * Recordatorios de una clase o trámite concreto = UTILITY. Ánimo y check-ins programados = MARKETING (criterio conservador).
 * `status` refleja la aprobación del proveedor; en la demo se asumen aprobadas.
 */
export const TEMPLATES = {
  recordatorio_clase: {
    name: 'recordatorio_clase',
    language: 'es',
    category: 'UTILITY',
    status: 'APPROVED',
    linkedTo: 'CLASE',
    body: 'Hola {{1}}, te recordamos tu clase de {{2}} hoy a las {{3}} en {{4}}. Responde BAJA si no deseas recibir mensajes.',
    endsWithQuestion: false,
  },
  vencimiento_tramite: {
    name: 'vencimiento_tramite',
    language: 'es',
    category: 'UTILITY',
    status: 'APPROVED',
    linkedTo: 'TRAMITE',
    body: 'Hola {{1}}, tu trámite "{{2}}" vence el {{3}}. Detalle: {{4}}. Responde BAJA si no deseas recibir mensajes.',
    endsWithQuestion: false,
  },
  cita_programada: {
    name: 'cita_programada',
    language: 'es',
    category: 'UTILITY',
    status: 'APPROVED',
    linkedTo: 'ALERTA',
    body: 'Hola {{1}}, {{2}} te contactará el {{3}} para la cita que coordinaron. Responde BAJA si no deseas recibir mensajes.',
    endsWithQuestion: false,
  },
  checkin_semanal: {
    name: 'checkin_semanal',
    language: 'es',
    category: 'MARKETING',
    status: 'APPROVED',
    linkedTo: 'CHECKIN',
    body: 'Hola {{1}}, soy Acompaña. Responde BAJA si no deseas recibir mensajes. Del 1 (muy mal) al 5 (muy bien), ¿cómo te sientes esta semana?',
    endsWithQuestion: true,
  },
  pastilla_semana: {
    name: 'pastilla_semana',
    language: 'es',
    category: 'MARKETING',
    status: 'APPROVED',
    linkedTo: null,
    body: 'Hola {{1}}, esta semana ves {{2}} en {{3}}. {{4}} Responde BAJA si no deseas recibir mensajes. ¿Quieres un tip para estudiarlo?',
    endsWithQuestion: true,
  },
} satisfies Record<string, TemplateDef>;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_CATALOG: Record<string, TemplateDef> = TEMPLATES;

export function renderTemplate(def: TemplateDef, params: string[]): string {
  return def.body.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? '');
}
