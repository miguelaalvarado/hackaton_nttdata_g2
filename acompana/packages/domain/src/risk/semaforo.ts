import type { Color, RuleSetConfig, WeeklySignals } from '../types';
import { assertAllowedFeatures, toFeatureVector, type RiskFeature } from './features';
import { contributions, predictProba, type LogisticModel } from './logistic';

export interface RiskThresholds {
  /** Probabilidad desde la que el color es amarillo. */
  amarillo: number;
  /** Probabilidad desde la que el color es rojo. */
  rojo: number;
}

export interface RiskReason {
  code: string;
  text: string;
  /** SUBE = empuja el riesgo; PROTEGE = factor a favor (se muestra solo si faltan razones de riesgo). */
  direction: 'SUBE' | 'PROTEGE';
  source: 'REGLA' | 'MODELO';
  weight: number;
}

export interface RiskResult {
  probability: number;
  color: Color;
  reasons: RiskReason[];
  rulesFired: string[];
  modelVersion: string;
}

export interface RiskInput {
  signals: WeeklySignals;
  rules: RuleSetConfig;
  /** Lenguaje de crisis detectado en la semana. */
  crisis: boolean;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function featureText(f: RiskFeature, v: number, up: boolean): string {
  switch (f) {
    case 'attendanceRate':
      return up ? `Asistencia baja: ${pct(v)} de clases esta semana` : `Buena asistencia (${pct(v)})`;
    case 'activeDays':
      return up ? `Poca conexión: ${v} día(s) activo(s) en la plataforma` : `Conectado/a ${v} días de la semana`;
    case 'studyHoursRatio':
      return up ? `Horas de estudio por debajo de la meta (${pct(v)} de la meta)` : `Cumple su meta de horas de estudio (${pct(v)})`;
    case 'avgPartial':
      return up ? `Notas parciales bajas (promedio ${v.toFixed(1)})` : `Buen promedio en parciales (${v.toFixed(1)})`;
    case 'failedAttempts':
      return up ? `${v} curso(s) desaprobado(s)` : 'Sin cursos desaprobados';
    case 'mood':
      return up ? `Ánimo bajo en el último check-in (${v}/5)` : `Ánimo estable (${v}/5)`;
  }
}

/** Semáforo: modelo logístico + reglas duras que fuerzan rojo. Devuelve siempre 3 razones. */
export function computeRisk(input: RiskInput, model: LogisticModel, thresholds: RiskThresholds): RiskResult {
  assertAllowedFeatures(model.features);
  const x = toFeatureVector(input.signals);
  const probability = predictProba(model, x);

  const ruleReasons: RiskReason[] = [];
  if (input.rules.failRuleApplies && input.signals.failedAttempts >= 1) {
    const left = input.rules.maxFailedCourses - input.signals.failedAttempts;
    ruleReasons.push({
      code: 'REGLA_DESAPROBADO_COHORTE_NUEVA',
      text:
        left <= 0
          ? `Alcanzó el límite de desaprobaciones de su cohorte (${input.rules.legalRef})`
          : `Curso desaprobado en cohorte nueva: una desaprobación más causa pérdida de beca (${input.rules.legalRef})`,
      direction: 'SUBE',
      source: 'REGLA',
      weight: 100,
    });
  }
  if (input.crisis) {
    ruleReasons.push({
      code: 'REGLA_CRISIS',
      text: 'Lenguaje de crisis en la conversación: requiere contacto humano inmediato',
      direction: 'SUBE',
      source: 'REGLA',
      weight: 200,
    });
  }

  const contrib = contributions(model, x)
    .filter((c) => !(c.feature === 'failedAttempts' && ruleReasons.some((r) => r.code.startsWith('REGLA_DESAPROBADO'))))
    .filter((c) => !(c.feature === 'mood' && input.signals.mood === null))
    .filter((c) => !(c.feature === 'avgPartial' && input.signals.avgPartial === null));
  const up = contrib
    .filter((c) => c.contribution > 0.15)
    .sort((a, b) => b.contribution - a.contribution)
    .map<RiskReason>((c) => ({
      code: `MODELO_${c.feature}`,
      text: featureText(c.feature as RiskFeature, c.value, true),
      direction: 'SUBE',
      source: 'MODELO',
      weight: c.contribution,
    }));
  const protect = contrib
    .filter((c) => c.contribution <= 0.15)
    .sort((a, b) => a.contribution - b.contribution)
    .map<RiskReason>((c) => ({
      code: `MODELO_${c.feature}`,
      text: featureText(c.feature as RiskFeature, c.value, false),
      direction: 'PROTEGE',
      source: 'MODELO',
      weight: c.contribution,
    }));

  const reasons = [...ruleReasons.sort((a, b) => b.weight - a.weight), ...up, ...protect].slice(0, 3);
  const rulesFired = ruleReasons.map((r) => r.code);
  const color: Color =
    rulesFired.length > 0 || probability >= thresholds.rojo ? 'ROJO' : probability >= thresholds.amarillo ? 'AMARILLO' : 'VERDE';

  return { probability, color, reasons, rulesFired, modelVersion: model.version };
}
