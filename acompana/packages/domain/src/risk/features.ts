import type { WeeklySignals } from '../types';

/**
 * Variables del modelo de riesgo. Solo conducta y desempeño observables.
 * Región de origen, lengua y pobreza NUNCA son variables del semáforo (regla de negocio, ver CLAUDE.md §2.2).
 */
export const RISK_FEATURES = ['attendanceRate', 'activeDays', 'studyHoursRatio', 'avgPartial', 'failedAttempts', 'mood'] as const;
export type RiskFeature = (typeof RISK_FEATURES)[number];

/** Variables prohibidas como causa directa de riesgo. Se valida al cargar cualquier modelo. */
export const FORBIDDEN_RISK_FEATURES = [
  'region',
  'originregion',
  'origen',
  'language',
  'lengua',
  'nativelanguage',
  'poverty',
  'pobreza',
  'sisfoh',
  'income',
  'ingreso',
  'ethnicity',
  'etnia',
];

export function assertAllowedFeatures(features: readonly string[]): void {
  const bad = features.filter((f) => FORBIDDEN_RISK_FEATURES.some((x) => f.toLowerCase().replace(/[_\s-]/g, '').includes(x)));
  if (bad.length) throw new Error(`Variables prohibidas en el modelo de riesgo: ${bad.join(', ')}`);
}

/** Valores neutros para imputar cuando falta un dato (no penaliza ni premia). */
const NEUTRAL = { avgPartial: 12, mood: 3 };

export function toFeatureVector(s: WeeklySignals): number[] {
  return [
    s.attendanceRate,
    s.activeDays,
    s.studyHoursTarget > 0 ? Math.min(s.studyHours / s.studyHoursTarget, 1.5) : 1,
    s.avgPartial ?? NEUTRAL.avgPartial,
    s.failedAttempts,
    s.mood ?? NEUTRAL.mood,
  ];
}
