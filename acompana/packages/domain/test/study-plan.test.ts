import { describe, expect, it } from 'vitest';
import { buildStudyPlan, canMarkBlock, courseArea, type StudyPlanInput } from '../src';

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const base: StudyPlanInput = {
  courses: [
    { id: 'MAT', name: 'Matemática Básica', credits: 4, schedule: [{ dow: 1, time: '08:00', room: 'A' }, { dow: 3, time: '10:00', room: 'A' }], avgGrade: 15, topic: 'Funciones' },
    { id: 'COM', name: 'Comunicación y Redacción', credits: 3, schedule: [{ dow: 2, time: '14:00', room: 'B' }], avgGrade: 16, topic: 'El ensayo' },
    { id: 'PRG', name: 'Programación I', credits: 4, schedule: [{ dow: 4, time: '16:00', room: 'C' }], avgGrade: 14.5, topic: 'Bucles' },
  ],
  studyHoursTarget: 12,
  passingGrade: 11,
  gpaWarningMargin: 1.5,
  diagnostic: { math: 80, reading: 85 },
  failedCourseNames: [],
  profiles: ['ESTABLE'],
};

describe('plan de estudio personalizado', () => {
  it('cubre la meta de horas, sin chocar con clases ni caer en el horario de silencio', () => {
    const p = buildStudyPlan(base);
    expect(p.totalMinutes).toBe(12 * 60);
    for (const b of p.blocks) {
      const s = toMin(b.start);
      expect(s).toBeGreaterThanOrEqual(7 * 60);
      expect(s + b.minutes).toBeLessThanOrEqual(22 * 60);
      for (const c of base.courses)
        for (const cl of c.schedule) if (cl.dow === b.dow) expect(s < toMin(cl.time) + 120 && s + b.minutes > toMin(cl.time)).toBe(false);
    }
    // Sin dos bloques a la misma hora
    expect(new Set(p.blocks.map((b) => `${b.dow}-${b.start}`)).size).toBe(p.blocks.length);
  });

  it('todos los cursos tienen tiempo; sin señales de riesgo no hay refuerzo ni nivelación', () => {
    const p = buildStudyPlan(base);
    for (const c of base.courses) expect(p.blocks.some((b) => b.courseId === c.id)).toBe(true);
    expect(p.priorities.every((x) => x.level === 'MANTENER')).toBe(true);
    expect(p.blocks.some((b) => b.kind !== 'ESTUDIO')).toBe(false);
  });

  it('parciales bajo el mínimo → refuerzo con más tiempo, asesoría reservada y el motivo explicado', () => {
    const p = buildStudyPlan({ ...base, courses: base.courses.map((c) => (c.id === 'MAT' ? { ...c, avgGrade: 10.4 } : c)) });
    const mat = p.priorities.find((x) => x.courseId === 'MAT')!;
    const prg = p.priorities.find((x) => x.courseId === 'PRG')!;
    expect(mat.level).toBe('REFUERZO');
    expect(mat.reason).toContain('10.4');
    expect(mat.minutes).toBeGreaterThan(prg.minutes);
    expect(p.blocks.some((b) => b.courseId === 'MAT' && b.kind === 'REFUERZO' && b.title.startsWith('Asesoría'))).toBe(true);
    expect(p.priorities[0].courseId).toBe('MAT');
  });

  it('asesorías solo para los cursos bajo el mínimo (máx. 2), empezando por la nota más baja', () => {
    const p = buildStudyPlan({
      ...base,
      courses: base.courses.map((c) => ({ ...c, avgGrade: c.id === 'MAT' ? 9.0 : c.id === 'COM' ? 10.5 : 11.8 })),
    });
    const advisories = p.blocks.filter((b) => b.kind === 'REFUERZO');
    expect(advisories.map((b) => b.courseId).sort()).toEqual(['COM', 'MAT']);
    expect(p.priorities.map((x) => x.courseId)).toEqual(['MAT', 'COM', 'PRG']);
    expect(p.priorities.find((x) => x.courseId === 'PRG')!.level).toBe('REFUERZO'); // cerca del mínimo: más tiempo, sin asesoría
    const many = buildStudyPlan({ ...base, courses: base.courses.map((c) => ({ ...c, avgGrade: 8 })) });
    expect(many.blocks.filter((b) => b.kind === 'REFUERZO')).toHaveLength(2);
  });

  it('diagnóstico bajo o módulo de nivelación desaprobado → sesiones de nivelación dentro de las horas', () => {
    const p = buildStudyPlan({ ...base, diagnostic: { math: 40, reading: 50 }, courses: base.courses.map((c) => ({ ...c, avgGrade: null })) });
    expect(p.blocks.filter((b) => b.title === 'Nivelación en matemática')).toHaveLength(2);
    expect(p.blocks.filter((b) => b.title === 'Nivelación en lectura')).toHaveLength(1);
    expect(p.totalMinutes).toBe(12 * 60);
    const failed = buildStudyPlan({ ...base, failedCourseNames: ['Nivelación en Matemática'] });
    expect(failed.blocks.some((b) => b.kind === 'NIVELACION' && b.reason.includes('Nivelación en Matemática'))).toBe(true);
  });

  it('tiempo y recursos → bloques más cortos y aviso de que el plan no cambia créditos', () => {
    const p = buildStudyPlan({ ...base, profiles: ['TIEMPO_RECURSOS'] });
    expect(p.blocks.every((b) => b.minutes === 45)).toBe(true);
    expect(p.notes.join(' ')).toMatch(/no cambia tus créditos/);
  });

  it('es determinista y respeta el máximo de bloques por día', () => {
    expect(buildStudyPlan(base)).toEqual(buildStudyPlan(base));
    const perDay = new Map<number, number>();
    for (const b of buildStudyPlan({ ...base, studyHoursTarget: 18 }).blocks) perDay.set(b.dow, (perDay.get(b.dow) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(3);
  });

  it('clasifica áreas y solo deja marcar bloques de hoy o días pasados', () => {
    expect(courseArea('Física I')).toBe('CUANTITATIVO');
    expect(courseArea('Comunicación y Redacción')).toBe('LECTURA');
    expect(courseArea('Anatomía I')).toBe('OTRO');
    expect(canMarkBlock(2, 4)).toBe(true);
    expect(canMarkBlock(5, 4)).toBe(false);
    expect(canMarkBlock(6, 0)).toBe(true); // domingo: toda la semana ya pasó
  });
});
