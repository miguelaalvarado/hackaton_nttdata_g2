import { describe, expect, it } from 'vitest';
import { evaluateScholarshipRules, losesScholarship, type AcademicRecord } from '../src';
import { NUEVO, PRE } from './fixtures';

const base: AcademicRecord = { weightedAverage: 15, termClosed: false, enrolledCredits: 22, cohortPercentile: 0.8, failedAttempts: 0 };
const byRule = (r: ReturnType<typeof evaluateScholarshipRules>, k: string) => r.find((e) => e.rule === k)!;

describe('reglas de beca (configurables por cohorte)', () => {
  it('becario al día cumple todas las reglas', () => {
    const r = evaluateScholarshipRules(NUEVO, base);
    expect(r.every((e) => e.status === 'CUMPLE')).toBe(true);
    expect(losesScholarship(r)).toBe(false);
  });

  it('cohorte nueva: 1 desaprobado = en riesgo; 2 desaprobaciones (mismo curso o distintos) = pierde', () => {
    expect(byRule(evaluateScholarshipRules(NUEVO, { ...base, failedAttempts: 1 }), 'DESAPROBADOS').status).toBe('EN_RIESGO');
    const two = evaluateScholarshipRules(NUEVO, { ...base, failedAttempts: 2 });
    expect(byRule(two, 'DESAPROBADOS').status).toBe('INCUMPLE');
    expect(losesScholarship(two)).toBe(true);
  });

  it('cohorte anterior al decreto: la causal de desaprobados no aplica', () => {
    const r = evaluateScholarshipRules(PRE, { ...base, failedAttempts: 3 });
    expect(byRule(r, 'DESAPROBADOS').status).toBe('NO_APLICA');
    expect(losesScholarship(r)).toBe(false);
  });

  it('el límite de desaprobaciones se lee del RuleSet, no del código', () => {
    const laxa = { ...NUEVO, maxFailedCourses: 3 };
    expect(byRule(evaluateScholarshipRules(laxa, { ...base, failedAttempts: 2 }), 'DESAPROBADOS').status).toBe('EN_RIESGO');
  });

  it('promedio: en curso bajo el mínimo es riesgo; periodo cerrado bajo el mínimo incumple', () => {
    expect(byRule(evaluateScholarshipRules(NUEVO, { ...base, weightedAverage: 10 }), 'PROMEDIO').status).toBe('EN_RIESGO');
    expect(byRule(evaluateScholarshipRules(NUEVO, { ...base, weightedAverage: 10, termClosed: true }), 'PROMEDIO').status).toBe('INCUMPLE');
    expect(byRule(evaluateScholarshipRules(NUEVO, { ...base, weightedAverage: 11.5 }), 'PROMEDIO').status).toBe('EN_RIESGO');
    expect(byRule(evaluateScholarshipRules(NUEVO, { ...base, weightedAverage: null }), 'PROMEDIO').status).toBe('SIN_DATOS');
  });

  it('créditos por debajo de lo previsto incumple; tercio superior es meta (riesgo, no incumplimiento)', () => {
    const r = evaluateScholarshipRules(NUEVO, { ...base, enrolledCredits: 18, cohortPercentile: 0.4 });
    expect(byRule(r, 'CREDITOS').status).toBe('INCUMPLE');
    expect(byRule(r, 'TERCIO_SUPERIOR').status).toBe('EN_RIESGO');
    expect(byRule(evaluateScholarshipRules({ ...NUEVO, requireTopThird: false }, base), 'TERCIO_SUPERIOR').status).toBe('NO_APLICA');
  });
});
