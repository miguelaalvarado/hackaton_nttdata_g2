import { clamp, type Rng } from './random';
import type { WeeklySignals } from './types';

/**
 * Generador de becarios SINTÉTICOS. Sirve al seed y al entrenamiento del modelo.
 * Los patrones están plantados a propósito: las métricas del modelo miden cuánto los recupera, no desempeño real.
 */
export interface LatentStudent {
  academic: number; // 0..1 (preparación académica)
  engagement: number; // 0..1
  wellbeing: number; // 0..1
  timePressure: number; // 0..1 (trabajo, traslados, cuidado)
  studyHoursTarget: number;
}

export function sampleLatent(rng: Rng): LatentStudent {
  return {
    academic: clamp(rng.normal(0.62, 0.18), 0.05, 1),
    engagement: clamp(rng.normal(0.68, 0.17), 0.05, 1),
    wellbeing: clamp(rng.normal(0.66, 0.18), 0.05, 1),
    timePressure: clamp(rng.normal(0.35, 0.2), 0, 1),
    studyHoursTarget: rng.pick([10, 12, 14]),
  };
}

/** Señales de una semana del ciclo (week 1..16) según el estado latente. */
export function sampleWeek(l: LatentStudent, week: number, rng: Rng, failedAttempts = 0): WeeklySignals {
  const fatigue = Math.max(0, week - 4) * 0.01;
  const attendance = clamp(0.55 + 0.4 * l.engagement - 0.15 * l.timePressure - fatigue + rng.normal(0, 0.06), 0, 1);
  const activeDays = Math.round(clamp(1 + 5.5 * l.engagement - 1.5 * l.timePressure + rng.normal(0, 0.8), 0, 7));
  const studyHours = Math.round(clamp(l.studyHoursTarget * (0.35 + 0.8 * l.engagement - 0.4 * l.timePressure) + rng.normal(0, 1.5), 0, 30));
  const avgPartial =
    week < 4 ? null : Math.round(clamp(6 + 9 * l.academic + 3 * l.engagement + rng.normal(0, 1.4), 0, 20) * 10) / 10;
  const mood = Math.round(clamp(1 + 4 * l.wellbeing + rng.normal(0, 0.5), 1, 5));
  return {
    attendanceRate: Math.round(attendance * 100) / 100,
    activeDays,
    studyHours,
    studyHoursTarget: l.studyHoursTarget,
    avgPartial,
    failedAttempts,
    mood: rng.chance(0.9) ? mood : null,
  };
}

/** Resultado oculto al fin del ciclo: 1 = abandona o pierde la beca. */
export function sampleOutcome(l: LatentStudent, failedAttempts: number, rng: Rng): 0 | 1 {
  const z =
    -1.9 - 3.2 * (l.academic - 0.6) - 3.0 * (l.engagement - 0.65) - 2.4 * (l.wellbeing - 0.65) + 1.2 * l.timePressure + 1.1 * failedAttempts;
  return rng.next() < 1 / (1 + Math.exp(-z)) ? 1 : 0;
}
