import type { Color, Profile } from './types';

export type Owner = { role: 'TUTOR'; specialty: 'ACADEMICO' | 'PSICOLOGIA' } | { role: 'MENTOR' } | { role: 'COORDINADOR' };

export interface Playbook {
  owner: Owner;
  /** Acción que hace el equipo. */
  teamAction: string;
  /** Siguiente paso concreto para el becario. Nunca un regaño. */
  scholarNextStep: string;
  /** Color mínimo de la alerta de este perfil. */
  minSeverity: Color;
}

/** Cada perfil activa una respuesta distinta. */
export const PLAYBOOKS: Record<Exclude<Profile, 'ESTABLE'>, Playbook> = {
  MALESTAR_EMOCIONAL: {
    owner: { role: 'TUTOR', specialty: 'PSICOLOGIA' },
    teamAction: 'Contactar al becario hoy y ofrecer una sesión con psicología.',
    scholarNextStep: 'Agenda una conversación con la psicóloga de tu universidad; es gratuita y confidencial.',
    minSeverity: 'AMARILLO',
  },
  EVENTO_VIDA: {
    owner: { role: 'COORDINADOR' },
    teamAction: 'Activar bienestar universitario y revisar opciones formales del programa (sin cambiar créditos sin acuerdo).',
    scholarNextStep: 'Cuéntale a tu coordinador lo que pasó para ver juntos las opciones; no tienes que resolverlo solo/a.',
    minSeverity: 'AMARILLO',
  },
  BARRERA_ACADEMICA: {
    owner: { role: 'TUTOR', specialty: 'ACADEMICO' },
    teamAction: 'Inscribir en refuerzo/nivelación del curso afectado y revisar plan de estudio.',
    scholarNextStep: 'Inscríbete esta semana en la asesoría del curso y separa 2 bloques de 1 hora para practicar.',
    minSeverity: 'AMARILLO',
  },
  INTEGRACION: {
    owner: { role: 'MENTOR' },
    teamAction: 'Mentor par: escribir y coordinar un encuentro presencial esta semana.',
    scholarNextStep: 'Tu mentor te escribirá para conocerse; acompáñalo a recorrer el campus y resolver lo pendiente del kit.',
    minSeverity: 'AMARILLO',
  },
  MOTIVACION_VOCACION: {
    owner: { role: 'TUTOR', specialty: 'ACADEMICO' },
    teamAction: 'Sesión de orientación vocacional y conexión con estudiantes de ciclos avanzados de la carrera.',
    scholarNextStep: 'Agenda 20 minutos con tu tutor para conversar sobre lo que esperabas de tu carrera.',
    minSeverity: 'AMARILLO',
  },
  TIEMPO_RECURSOS: {
    owner: { role: 'COORDINADOR' },
    teamAction:
      'Revisar con el becario su carga de tiempo y apoyos disponibles. No reducir créditos: cualquier cambio de matrícula lo decide el becario con su coordinador según las reglas de su cohorte.',
    scholarNextStep: 'Armemos juntos tu horario de la semana: identifica 3 bloques fijos de estudio y conversa con tu coordinador sobre apoyos.',
    minSeverity: 'AMARILLO',
  },
};

const RANK: Record<Color, number> = { VERDE: 0, AMARILLO: 1, ROJO: 2 };
export const maxColor = (a: Color, b: Color): Color => (RANK[a] >= RANK[b] ? a : b);
