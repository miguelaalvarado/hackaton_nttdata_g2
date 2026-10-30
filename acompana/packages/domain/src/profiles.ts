import type { Profile, RuleSetConfig, WeeklySignals } from './types';

export interface ProfileInput {
  current: WeeklySignals;
  previous: WeeklySignals | null;
  /** Ánimo de los últimos check-ins, del más reciente al más antiguo. */
  recentMoods: number[];
  rules: RuleSetConfig;
  onboarding: {
    careerFit: number | null; // 1..5
    mathScore: number | null; // 0..100
    readingScore: number | null; // 0..100
    livesAlone: boolean;
    /** Estudia fuera de su región de origen. Solo activa contexto de integración, nunca riesgo por sí solo. */
    studiesAwayFromHome: boolean;
  };
  overdueChecklistItems: number;
  lifeEventReported: boolean;
  distressLanguage: boolean;
  crisis: boolean;
}

export interface ProfileThresholds {
  lowDiagnosticScore: number;
  lowActiveDays: number;
  overdueChecklistItems: number;
  lowStudyRatio: number;
  lowAttendance: number;
  attendanceDrop: number;
  lowCareerFit: number;
  lowMood: number;
  lowMoodWeeks: number;
}

export const DEFAULT_PROFILE_THRESHOLDS: ProfileThresholds = {
  lowDiagnosticScore: 50,
  lowActiveDays: 2,
  overdueChecklistItems: 2,
  lowStudyRatio: 0.6,
  lowAttendance: 0.75,
  attendanceDrop: 0.15,
  lowCareerFit: 2,
  lowMood: 2,
  lowMoodWeeks: 2,
};

/** Orden de atención. Malestar emocional y evento de vida siempre primero. */
export const PROFILE_PRIORITY: Profile[] = [
  'MALESTAR_EMOCIONAL',
  'EVENTO_VIDA',
  'BARRERA_ACADEMICA',
  'INTEGRACION',
  'MOTIVACION_VOCACION',
  'TIEMPO_RECURSOS',
  'ESTABLE',
];

export interface ProfileResult {
  profiles: Profile[];
  primary: Profile;
  evidence: Partial<Record<Profile, string[]>>;
}

/** Perfiles combinables de la semana. ESTABLE solo si no aplica ningún otro. */
export function detectProfiles(i: ProfileInput, t: ProfileThresholds = DEFAULT_PROFILE_THRESHOLDS): ProfileResult {
  const ev: Partial<Record<Profile, string[]>> = {};
  const add = (p: Profile, why: string) => (ev[p] ??= []).push(why);
  const c = i.current;

  // Barrera académica
  if (c.failedAttempts > 0) add('BARRERA_ACADEMICA', `${c.failedAttempts} curso(s) desaprobado(s)`);
  if (c.avgPartial !== null && c.avgPartial < i.rules.passingGrade) add('BARRERA_ACADEMICA', `Parciales en ${c.avgPartial.toFixed(1)}`);
  const lowDiag = [i.onboarding.mathScore, i.onboarding.readingScore].some((s) => s !== null && s < t.lowDiagnosticScore);
  if (lowDiag && c.avgPartial !== null && c.avgPartial < i.rules.passingGrade + i.rules.gpaWarningMargin) {
    add('BARRERA_ACADEMICA', 'Diagnóstico inicial bajo y parciales cerca del mínimo');
  }

  // Integración: contexto (vive solo / fuera de casa) + señal de conducta
  if (i.onboarding.livesAlone || i.onboarding.studiesAwayFromHome) {
    if (c.activeDays <= t.lowActiveDays) add('INTEGRACION', `Baja conexión (${c.activeDays} días activos) estando lejos de casa`);
    if (i.overdueChecklistItems >= t.overdueChecklistItems) add('INTEGRACION', `${i.overdueChecklistItems} pendientes del kit de llegada vencidos`);
  }

  // Motivación y vocación
  const dropped = i.previous !== null && i.previous.attendanceRate - c.attendanceRate >= t.attendanceDrop;
  if (i.onboarding.careerFit !== null && i.onboarding.careerFit <= t.lowCareerFit && (dropped || c.attendanceRate < t.lowAttendance)) {
    add('MOTIVACION_VOCACION', 'Bajo encaje con la carrera y caída de asistencia');
  }

  // Malestar emocional
  const lowMoods = i.recentMoods.slice(0, t.lowMoodWeeks);
  if (lowMoods.length >= t.lowMoodWeeks && lowMoods.every((m) => m <= t.lowMood)) {
    add('MALESTAR_EMOCIONAL', `Ánimo bajo ${t.lowMoodWeeks} semanas seguidas`);
  }
  if (i.distressLanguage) add('MALESTAR_EMOCIONAL', 'Expresó malestar en la conversación');
  if (i.crisis) add('MALESTAR_EMOCIONAL', 'Lenguaje de crisis detectado');

  // Evento de vida
  if (i.lifeEventReported) add('EVENTO_VIDA', 'Evento de vida reportado');

  // Tiempo y recursos (no se activa si el problema principal es emocional)
  const studyRatio = c.studyHoursTarget > 0 ? c.studyHours / c.studyHoursTarget : 1;
  if (studyRatio < t.lowStudyRatio && c.attendanceRate < t.lowAttendance && !ev.MALESTAR_EMOCIONAL) {
    add('TIEMPO_RECURSOS', 'Pocas horas de estudio y asistencia irregular');
  }

  const profiles = PROFILE_PRIORITY.filter((p) => p !== 'ESTABLE' && ev[p]);
  if (!profiles.length) {
    return { profiles: ['ESTABLE'], primary: 'ESTABLE', evidence: { ESTABLE: ['Sin señales de riesgo esta semana'] } };
  }
  return { profiles, primary: profiles[0], evidence: ev };
}
