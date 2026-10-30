import { describe, expect, it } from 'vitest';
import { assertAllowedFeatures, computeRisk, riskModel, RISK_FEATURES, trainSyntheticModel, type LogisticModel } from '../src';
import { goodWeek, NUEVO, PRE } from './fixtures';

const model = riskModel as LogisticModel;
const TH = { amarillo: 0.3, rojo: 0.55 };

describe('semáforo de riesgo', () => {
  it('semana buena = verde, con 3 razones', () => {
    const r = computeRisk({ signals: goodWeek, rules: NUEVO, crisis: false }, model, TH);
    expect(r.color).toBe('VERDE');
    expect(r.reasons).toHaveLength(3);
  });

  it('cohorte nueva con 1 curso desaprobado = rojo por regla, y es la primera razón', () => {
    const r = computeRisk({ signals: { ...goodWeek, failedAttempts: 1 }, rules: NUEVO, crisis: false }, model, TH);
    expect(r.color).toBe('ROJO');
    expect(r.rulesFired).toContain('REGLA_DESAPROBADO_COHORTE_NUEVA');
    expect(r.reasons[0].source).toBe('REGLA');
  });

  it('cohorte anterior con 1 desaprobado no fuerza rojo por regla', () => {
    const r = computeRisk({ signals: { ...goodWeek, failedAttempts: 1 }, rules: PRE, crisis: false }, model, TH);
    expect(r.rulesFired).toHaveLength(0);
    expect(r.color).not.toBe('ROJO');
  });

  it('crisis fuerza rojo', () => {
    const r = computeRisk({ signals: goodWeek, rules: PRE, crisis: true }, model, TH);
    expect(r.color).toBe('ROJO');
    expect(r.reasons[0].code).toBe('REGLA_CRISIS');
  });

  it('señales malas suben la probabilidad y las razones explican el porqué', () => {
    const bad = { ...goodWeek, attendanceRate: 0.5, activeDays: 1, studyHours: 3, avgPartial: 8.5, mood: 2 };
    const good = computeRisk({ signals: goodWeek, rules: PRE, crisis: false }, model, TH);
    const r = computeRisk({ signals: bad, rules: PRE, crisis: false }, model, TH);
    expect(r.probability).toBeGreaterThan(good.probability);
    expect(r.color).not.toBe('VERDE');
    expect(r.reasons.every((x) => x.direction === 'SUBE')).toBe(true);
  });

  it('los umbrales de color son configurables', () => {
    const strict = computeRisk({ signals: goodWeek, rules: PRE, crisis: false }, model, { amarillo: 0, rojo: 0.99 });
    expect(strict.color).toBe('AMARILLO');
  });

  it('nunca usa origen, lengua ni pobreza como variable', () => {
    expect(() => assertAllowedFeatures(model.features)).not.toThrow();
    expect(() => assertAllowedFeatures(['attendanceRate', 'origin_region'])).toThrow();
    expect(() => assertAllowedFeatures(['lengua_materna'])).toThrow();
    expect(() => assertAllowedFeatures(['pobreza'])).toThrow();
    expect(() => computeRisk({ signals: goodWeek, rules: PRE, crisis: false }, { ...model, features: [...model.features, 'region'] }, TH)).toThrow();
  });

  it('el modelo versionado coincide con el entrenamiento reproducible', () => {
    const m = trainSyntheticModel();
    expect(m.features).toEqual([...RISK_FEATURES]);
    expect(m.coef.map((c) => +c.toFixed(6))).toEqual(model.coef.map((c) => +c.toFixed(6)));
    // Signos esperados: más asistencia, conexión, notas y ánimo bajan el riesgo; desaprobados lo sube.
    const coef = Object.fromEntries(m.features.map((f, i) => [f, m.coef[i]]));
    expect(coef.activeDays).toBeLessThan(0);
    expect(coef.avgPartial).toBeLessThan(0);
    expect(coef.mood).toBeLessThan(0);
    expect(coef.failedAttempts).toBeGreaterThan(0);
  });
});
