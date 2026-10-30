import type { AcademicRecord, RuleSetConfig } from './types';

export type RuleStatus = 'CUMPLE' | 'EN_RIESGO' | 'INCUMPLE' | 'NO_APLICA' | 'SIN_DATOS';
export type RuleKey = 'PROMEDIO' | 'CREDITOS' | 'TERCIO_SUPERIOR' | 'DESAPROBADOS';

export interface RuleEvaluation {
  rule: RuleKey;
  status: RuleStatus;
  detail: string;
}

const fmt = (n: number) => n.toFixed(1);

/** Evalúa la situación del becario frente a las reglas de su cohorte. Mensajes en tono de acompañamiento. */
export function evaluateScholarshipRules(rules: RuleSetConfig, rec: AcademicRecord): RuleEvaluation[] {
  return [evalAverage(rules, rec), evalCredits(rules, rec), evalTopThird(rules, rec), evalFailed(rules, rec)];
}

function evalAverage(rules: RuleSetConfig, rec: AcademicRecord): RuleEvaluation {
  const avg = rec.weightedAverage;
  if (avg === null) {
    return { rule: 'PROMEDIO', status: 'SIN_DATOS', detail: 'Aún no hay notas registradas este periodo.' };
  }
  if (avg < rules.passingGrade) {
    return rec.termClosed
      ? { rule: 'PROMEDIO', status: 'INCUMPLE', detail: `Tu promedio ponderado fue ${fmt(avg)}; el mínimo es ${rules.passingGrade}.` }
      : {
          rule: 'PROMEDIO',
          status: 'EN_RIESGO',
          detail: `Con tus parciales vas en ${fmt(avg)}; necesitas al menos ${rules.passingGrade}. Aún estás a tiempo.`,
        };
  }
  if (avg < rules.passingGrade + rules.gpaWarningMargin) {
    return { rule: 'PROMEDIO', status: 'EN_RIESGO', detail: `Vas en ${fmt(avg)}, muy cerca del mínimo (${rules.passingGrade}).` };
  }
  return { rule: 'PROMEDIO', status: 'CUMPLE', detail: `Vas en ${fmt(avg)}; el mínimo es ${rules.passingGrade}.` };
}

function evalCredits(rules: RuleSetConfig, rec: AcademicRecord): RuleEvaluation {
  if (rec.enrolledCredits >= rules.minCreditsPerTerm) {
    return { rule: 'CREDITOS', status: 'CUMPLE', detail: `Matriculaste ${rec.enrolledCredits} créditos (previstos: ${rules.minCreditsPerTerm}).` };
  }
  return {
    rule: 'CREDITOS',
    status: 'INCUMPLE',
    detail: `Matriculaste ${rec.enrolledCredits} de ${rules.minCreditsPerTerm} créditos previstos. Consulta con tu coordinador.`,
  };
}

function evalTopThird(rules: RuleSetConfig, rec: AcademicRecord): RuleEvaluation {
  if (!rules.requireTopThird) return { rule: 'TERCIO_SUPERIOR', status: 'NO_APLICA', detail: 'No aplica a tu cohorte.' };
  if (rec.cohortPercentile === null) {
    return { rule: 'TERCIO_SUPERIOR', status: 'SIN_DATOS', detail: 'Aún no hay ranking del periodo.' };
  }
  if (rec.cohortPercentile >= 2 / 3) {
    return { rule: 'TERCIO_SUPERIOR', status: 'CUMPLE', detail: 'Estás en el tercio superior de tu carrera.' };
  }
  // El tercio superior es una meta de trayectoria: se muestra como riesgo, no como incumplimiento.
  return {
    rule: 'TERCIO_SUPERIOR',
    status: 'EN_RIESGO',
    detail: `Estás en el puesto ${Math.round((1 - rec.cohortPercentile) * 100)}% desde arriba; la meta es el tercio superior.`,
  };
}

function evalFailed(rules: RuleSetConfig, rec: AcademicRecord): RuleEvaluation {
  if (!rules.failRuleApplies) {
    return {
      rule: 'DESAPROBADOS',
      status: 'NO_APLICA',
      detail: 'La causal por cursos desaprobados no aplica a tu cohorte (beca adjudicada antes del decreto).',
    };
  }
  const left = rules.maxFailedCourses - rec.failedAttempts;
  if (left <= 0) {
    return {
      rule: 'DESAPROBADOS',
      status: 'INCUMPLE',
      detail: `Registras ${rec.failedAttempts} desaprobaciones; el límite es ${rules.maxFailedCourses - 1}.`,
    };
  }
  if (rec.failedAttempts > 0) {
    return {
      rule: 'DESAPROBADOS',
      status: 'EN_RIESGO',
      detail:
        left === 1
          ? 'Tienes 1 curso desaprobado: una desaprobación más haría perder la beca.'
          : `Tienes ${rec.failedAttempts} desaprobaciones; te quedan ${left - 1} de margen.`,
    };
  }
  return { rule: 'DESAPROBADOS', status: 'CUMPLE', detail: 'No tienes cursos desaprobados.' };
}

/** true si alguna regla de su cohorte ya se incumplió. */
export function losesScholarship(evals: RuleEvaluation[]): boolean {
  return evals.some((e) => e.status === 'INCUMPLE');
}
