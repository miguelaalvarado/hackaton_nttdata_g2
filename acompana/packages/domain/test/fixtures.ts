import type { RuleSetConfig, WeeklySignals } from '../src';

export const NUEVO: RuleSetConfig = {
  code: 'NUEVO_DS017',
  name: 'Becarios adjudicados desde el DS 017-2026-MINEDU',
  legalRef: 'DS 017-2026-MINEDU',
  passingGrade: 11,
  gpaWarningMargin: 1.5,
  minCreditsPerTerm: 20,
  requireTopThird: true,
  failRuleApplies: true,
  maxFailedCourses: 2,
};

export const PRE: RuleSetConfig = { ...NUEVO, code: 'PRE_DS017', name: 'Adjudicados antes del decreto', failRuleApplies: false };

export const goodWeek: WeeklySignals = {
  attendanceRate: 0.95,
  activeDays: 6,
  studyHours: 13,
  studyHoursTarget: 12,
  avgPartial: 15.5,
  failedAttempts: 0,
  mood: 4,
};
