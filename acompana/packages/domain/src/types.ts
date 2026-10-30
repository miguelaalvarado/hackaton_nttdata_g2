export type Role = 'BECARIO' | 'MENTOR' | 'TUTOR' | 'COORDINADOR';
export type Color = 'VERDE' | 'AMARILLO' | 'ROJO';

export const PROFILES = [
  'ESTABLE',
  'BARRERA_ACADEMICA',
  'TIEMPO_RECURSOS',
  'INTEGRACION',
  'MOTIVACION_VOCACION',
  'MALESTAR_EMOCIONAL',
  'EVENTO_VIDA',
] as const;
export type Profile = (typeof PROFILES)[number];

/** Reglas de una cohorte. Viven en la BD (tabla RuleSet); el código nunca fija estos valores. */
export interface RuleSetConfig {
  code: string;
  name: string;
  legalRef: string;
  /** Nota mínima aprobatoria (escala vigesimal). */
  passingGrade: number;
  /** Margen sobre la nota aprobatoria a partir del cual se marca "en riesgo". */
  gpaWarningMargin: number;
  /** Créditos que el becario debe matricular por periodo. */
  minCreditsPerTerm: number;
  requireTopThird: boolean;
  /** Si aplica la causal de pérdida por desaprobar cursos. */
  failRuleApplies: boolean;
  /** Número de desaprobaciones (mismo curso o distintos) que causa la pérdida. */
  maxFailedCourses: number;
}

export interface AcademicRecord {
  /** Promedio ponderado del periodo (proyectado con parciales si el periodo está en curso). */
  weightedAverage: number | null;
  termClosed: boolean;
  enrolledCredits: number;
  /** Percentil en la cohorte de su carrera (0 = último, 1 = primero). */
  cohortPercentile: number | null;
  /** Total de desaprobaciones en la vigencia de la beca (cada intento desaprobado cuenta). */
  failedAttempts: number;
}

export interface WeeklySignals {
  /** 0..1 */
  attendanceRate: number;
  /** Días con actividad en la plataforma/LMS en la semana (0..7). */
  activeDays: number;
  studyHours: number;
  studyHoursTarget: number;
  /** Promedio de notas parciales (0..20); null si aún no hay parciales. */
  avgPartial: number | null;
  failedAttempts: number;
  /** Ánimo del último check-in (1..5); null si no respondió. */
  mood: number | null;
}
