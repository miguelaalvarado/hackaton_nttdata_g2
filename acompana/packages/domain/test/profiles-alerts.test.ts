import { describe, expect, it } from 'vitest';
import {
  buildAlerts,
  computeRisk,
  detectProfiles,
  PLAYBOOKS,
  registerFirstAction,
  riskModel,
  slaStatus,
  type LogisticModel,
  type ProfileInput,
} from '../src';
import { goodWeek, NUEVO, PRE } from './fixtures';

const base: ProfileInput = {
  current: goodWeek,
  previous: goodWeek,
  recentMoods: [4, 4],
  rules: NUEVO,
  onboarding: { careerFit: 4, mathScore: 70, readingScore: 75, livesAlone: false, studiesAwayFromHome: false },
  overdueChecklistItems: 0,
  lifeEventReported: false,
  distressLanguage: false,
  crisis: false,
};
const TH = { amarillo: 0.3, rojo: 0.55 };
const now = new Date('2026-10-26T15:00:00Z');

describe('perfiles', () => {
  it('sin señales = ESTABLE (excluyente)', () => {
    const r = detectProfiles(base);
    expect(r.profiles).toEqual(['ESTABLE']);
  });

  it('Luis: vive solo, lejos de casa, poca conexión y un curso desaprobado → INTEGRACION + BARRERA_ACADEMICA', () => {
    const r = detectProfiles({
      ...base,
      current: { ...goodWeek, activeDays: 1, failedAttempts: 1, avgPartial: 10.2 },
      onboarding: { ...base.onboarding, livesAlone: true, studiesAwayFromHome: true },
      overdueChecklistItems: 2,
    });
    expect(r.profiles).toEqual(['BARRERA_ACADEMICA', 'INTEGRACION']);
    expect(r.profiles).not.toContain('ESTABLE');
  });

  it('vivir lejos de casa por sí solo NO activa ningún perfil', () => {
    const r = detectProfiles({ ...base, onboarding: { ...base.onboarding, livesAlone: true, studiesAwayFromHome: true } });
    expect(r.profiles).toEqual(['ESTABLE']);
  });

  it('malestar emocional y evento de vida tienen prioridad sobre los demás', () => {
    const r = detectProfiles({
      ...base,
      current: { ...goodWeek, failedAttempts: 1, mood: 2 },
      recentMoods: [2, 1],
      lifeEventReported: true,
    });
    expect(r.primary).toBe('MALESTAR_EMOCIONAL');
    expect(r.profiles.slice(0, 2)).toEqual(['MALESTAR_EMOCIONAL', 'EVENTO_VIDA']);
  });

  it('malestar por lenguaje en la conversación o crisis', () => {
    expect(detectProfiles({ ...base, distressLanguage: true }).profiles).toContain('MALESTAR_EMOCIONAL');
    expect(detectProfiles({ ...base, crisis: true }).primary).toBe('MALESTAR_EMOCIONAL');
  });

  it('motivación/vocación: bajo encaje + caída de asistencia', () => {
    const r = detectProfiles({
      ...base,
      onboarding: { ...base.onboarding, careerFit: 2 },
      previous: { ...goodWeek, attendanceRate: 0.95 },
      current: { ...goodWeek, attendanceRate: 0.7 },
    });
    expect(r.profiles).toContain('MOTIVACION_VOCACION');
  });

  it('tiempo y recursos: el playbook nunca reduce créditos por su cuenta', () => {
    const r = detectProfiles({ ...base, current: { ...goodWeek, studyHours: 4, attendanceRate: 0.6 } });
    expect(r.profiles).toContain('TIEMPO_RECURSOS');
    expect(PLAYBOOKS.TIEMPO_RECURSOS.teamAction).toMatch(/No reducir créditos/);
    expect(PLAYBOOKS.TIEMPO_RECURSOS.scholarNextStep).not.toMatch(/reduc|retir/i);
  });
});

describe('alertas y SLA 48 h', () => {
  it('cohorte nueva + 1 desaprobado → alertas rojas al equipo con responsable y vencimiento de 48 h, y paso siguiente al becario', () => {
    const signals = { ...goodWeek, activeDays: 1, failedAttempts: 1, avgPartial: 10.2 };
    const risk = computeRisk({ signals, rules: NUEVO, crisis: false }, riskModel as LogisticModel, TH);
    const profiles = detectProfiles({
      ...base,
      current: signals,
      onboarding: { ...base.onboarding, livesAlone: true, studiesAwayFromHome: true },
    });
    const alerts = buildAlerts({ scholarId: 's1', weekKey: '2026-10-26', risk, profiles, now });
    const team = alerts.filter((a) => a.direction === 'TEAM');
    expect(team.length).toBe(2);
    for (const a of team) {
      expect(a.severity).toBe('ROJO');
      expect(a.owner).not.toBeNull();
      expect(a.dueAt!.getTime() - now.getTime()).toBe(48 * 3600_000);
    }
    const scholar = alerts.find((a) => a.direction === 'SCHOLAR')!;
    expect(scholar.nextStep.length).toBeGreaterThan(10);
    expect(scholar.nextStep).not.toMatch(/deberías haber|por no|culpa|irresponsable/i);
  });

  it('malestar emocional se asigna a psicología', () => {
    const risk = computeRisk({ signals: goodWeek, rules: PRE, crisis: true }, riskModel as LogisticModel, TH);
    const profiles = detectProfiles({ ...base, crisis: true });
    const [team] = buildAlerts({ scholarId: 'rosa', weekKey: 'w', risk, profiles, now });
    expect(team.owner).toEqual({ role: 'TUTOR', specialty: 'PSICOLOGIA' });
    expect(team.severity).toBe('ROJO');
  });

  it('becario estable y verde no genera alertas; las claves de deduplicación son por semana', () => {
    const risk = computeRisk({ signals: goodWeek, rules: NUEVO, crisis: false }, riskModel as LogisticModel, TH);
    expect(buildAlerts({ scholarId: 'ana', weekKey: 'w', risk, profiles: detectProfiles(base), now })).toEqual([]);
  });

  it('SLA: cumplida si la primera acción humana llega dentro de 48 h; las acciones posteriores no la cambian', () => {
    const dueAt = new Date(now.getTime() + 48 * 3600_000);
    expect(slaStatus({ dueAt, firstActionAt: null }, now)).toBe('EN_PLAZO');
    expect(slaStatus({ dueAt, firstActionAt: null }, new Date(dueAt.getTime() + 1))).toBe('VENCIDA');
    const first = registerFirstAction({ dueAt, firstActionAt: null, slaMet: null }, new Date(now.getTime() + 3600_000));
    expect(first.slaMet).toBe(true);
    const again = registerFirstAction({ dueAt, ...first }, new Date(dueAt.getTime() + 999_999));
    expect(again).toEqual(first);
    expect(registerFirstAction({ dueAt, firstActionAt: null, slaMet: null }, new Date(dueAt.getTime() + 1)).slaMet).toBe(false);
    expect(slaStatus({ dueAt, firstActionAt: new Date(dueAt.getTime() + 1) }, now)).toBe('INCUMPLIDA');
  });
});
