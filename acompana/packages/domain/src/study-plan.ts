/**
 * Plan de estudio semanal personalizado. Función pura: mismas entradas → mismo plan.
 * Personaliza según notas parciales, diagnóstico de entrada, cursos desaprobados, horario de clases y perfil de la semana.
 * Nunca reduce créditos ni cambia la matrícula: solo organiza el tiempo de estudio.
 */

export type StudyArea = 'CUANTITATIVO' | 'LECTURA' | 'OTRO';
export type BlockKind = 'ESTUDIO' | 'REFUERZO' | 'NIVELACION';

export interface PlanCourse {
  id: string;
  name: string;
  credits: number;
  /** dow: 0 = domingo … 6 = sábado (hora de Lima). Cada clase dura classMinutes. */
  schedule: { dow: number; time: string; room: string }[];
  /** Promedio de parciales del curso; null si aún no hay notas. */
  avgGrade: number | null;
  topic: string | null;
}

export interface StudyPlanInput {
  courses: PlanCourse[];
  studyHoursTarget: number;
  passingGrade: number;
  gpaWarningMargin: number;
  diagnostic: { math: number | null; reading: number | null };
  /** Cursos ya desaprobados (p. ej. un módulo de nivelación cerrado). */
  failedCourseNames: string[];
  /** Perfiles de la semana (ver profiles.ts). */
  profiles: string[];
  config?: Partial<StudyPlanConfig>;
}

export interface StudyPlanConfig {
  /** Puntaje (0–100) bajo el cual el diagnóstico pide nivelación o refuerzo. */
  lowDiagnosticScore: number;
  /** Peso extra de un curso en refuerzo frente a uno que va bien. */
  reinforcementWeight: number;
  blockMinutes: number;
  /** Bloques más cortos cuando el perfil es TIEMPO_RECURSOS (encajan mejor en semanas apretadas). */
  shortBlockMinutes: number;
  classMinutes: number;
  /** Horarios candidatos para estudiar (todos fuera del silencio 22:00–07:00). */
  slots: string[];
  /** Días de estudio: 1 = lunes … 6 = sábado. */
  days: number[];
  maxBlocksPerDay: number;
  /** Máximo de asesorías reservadas por semana (para los cursos más comprometidos). */
  maxAdvisories: number;
}

export const DEFAULT_STUDY_PLAN_CONFIG: StudyPlanConfig = {
  lowDiagnosticScore: 60,
  reinforcementWeight: 1.6,
  blockMinutes: 60,
  shortBlockMinutes: 45,
  classMinutes: 120,
  slots: ['08:00', '10:00', '12:00', '15:00', '17:00', '19:00'],
  days: [1, 2, 3, 4, 5, 6],
  maxBlocksPerDay: 3,
  maxAdvisories: 2,
};

export interface PlannedBlock {
  dow: number;
  start: string;
  minutes: number;
  courseId: string | null;
  title: string;
  kind: BlockKind;
  topic: string | null;
  reason: string;
}

export interface CoursePriority {
  courseId: string;
  name: string;
  level: 'REFUERZO' | 'MANTENER';
  minutes: number;
  reason: string;
}

export interface StudyPlan {
  blocks: PlannedBlock[];
  priorities: CoursePriority[];
  totalMinutes: number;
  notes: string[];
}

export function courseArea(name: string): StudyArea {
  const n = name.toLowerCase();
  if (/matem|f[ií]sica|program|contab|econom|estad|c[aá]lculo/.test(n)) return 'CUANTITATIVO';
  if (/comunica|redac|lectura|lenguaje/.test(n)) return 'LECTURA';
  return 'OTRO';
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const DAY_NAME = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function buildStudyPlan(input: StudyPlanInput): StudyPlan {
  const cfg = { ...DEFAULT_STUDY_PLAN_CONFIG, ...input.config };
  const short = input.profiles.includes('TIEMPO_RECURSOS');
  const blockMin = short ? cfg.shortBlockMinutes : cfg.blockMinutes;
  const lowMath = input.diagnostic.math !== null && input.diagnostic.math < cfg.lowDiagnosticScore;
  const lowReading = input.diagnostic.reading !== null && input.diagnostic.reading < cfg.lowDiagnosticScore;
  const failedQuant = input.failedCourseNames.filter((n) => courseArea(n) === 'CUANTITATIVO');
  const notes: string[] = [];

  // 1. Prioridad y motivo por curso
  const pri = input.courses.map((c) => {
    const area = courseArea(c.name);
    let reason: string;
    let refuerzo = false;
    let urgent = false;
    if (c.avgGrade !== null && c.avgGrade < input.passingGrade) {
      refuerzo = true;
      urgent = true;
      reason = `Tus parciales van en ${c.avgGrade.toFixed(1)} y el mínimo es ${input.passingGrade}: le damos más tiempo.`;
    } else if (c.avgGrade !== null && c.avgGrade < input.passingGrade + input.gpaWarningMargin) {
      refuerzo = true;
      reason = `Vas en ${c.avgGrade.toFixed(1)}, cerca del mínimo (${input.passingGrade}): un poco más de práctica te da margen.`;
    } else if (c.avgGrade === null && ((area === 'CUANTITATIVO' && (lowMath || failedQuant.length > 0)) || (area === 'LECTURA' && lowReading))) {
      refuerzo = true;
      urgent = true;
      reason =
        area === 'LECTURA'
          ? `Tu diagnóstico de lectura fue ${input.diagnostic.reading} %: empezamos con más práctica de lectura y redacción.`
          : `Tu diagnóstico de matemática${failedQuant.length ? ' y tu nivelación' : ''} indican que conviene practicar más desde el inicio.`;
    } else if (c.avgGrade !== null) {
      reason = `Vas en ${c.avgGrade.toFixed(1)}: mantén el ritmo.`;
    } else {
      reason = 'Aún no hay notas: tiempo regular de estudio según sus créditos.';
    }
    return { c, refuerzo, urgent, reason, weight: c.credits * (refuerzo ? cfg.reinforcementWeight : 1) };
  });
  // Asesorías: solo para los cursos más comprometidos (bajo el mínimo o diagnóstico bajo sin notas), empezando por la nota más baja.
  const advisory = new Set(
    pri
      .filter((p) => p.urgent)
      .sort((a, b) => (a.c.avgGrade ?? -1) - (b.c.avgGrade ?? -1) || a.c.id.localeCompare(b.c.id))
      .slice(0, cfg.maxAdvisories)
      .map((p) => p.c.id),
  );
  for (const p of pri) if (advisory.has(p.c.id)) p.reason = `${p.reason.replace(/\.$/, '')} y una asesoría reservada.`;

  // 2. Nivelación: diagnóstico bajo o módulo cuantitativo desaprobado
  const nivel: PlannedBlock[] = [];
  if (lowMath || failedQuant.length) {
    const why = failedQuant.length
      ? `Desaprobaste ${failedQuant[0]}; repasar lo básico te ayuda en tus cursos de números.`
      : `Tu diagnóstico de matemática fue ${input.diagnostic.math} %.`;
    for (let i = 0; i < 2; i++) nivel.push({ dow: 0, start: '', minutes: blockMin, courseId: null, title: 'Nivelación en matemática', kind: 'NIVELACION', topic: 'Ejercicios básicos', reason: why });
  }
  if (lowReading) {
    nivel.push({ dow: 0, start: '', minutes: blockMin, courseId: null, title: 'Nivelación en lectura', kind: 'NIVELACION', topic: 'Comprensión y resumen', reason: `Tu diagnóstico de lectura fue ${input.diagnostic.reading} %.` });
  }

  // 3. Reparto de minutos por peso, en bloques enteros (mínimo 1 por curso)
  const targetBlocks = Math.max(input.courses.length, Math.round((input.studyHoursTarget * 60) / blockMin));
  const courseBlocks = Math.max(input.courses.length, targetBlocks - nivel.length);
  const totalW = pri.reduce((s, p) => s + p.weight, 0) || 1;
  const alloc = pri.map((p) => ({ ...p, n: Math.max(1, Math.floor((courseBlocks * p.weight) / totalW)) }));
  let left = courseBlocks - alloc.reduce((s, a) => s + a.n, 0);
  for (const a of [...alloc].sort((x, y) => y.weight - x.weight || x.c.id.localeCompare(y.c.id))) {
    if (left <= 0) break;
    a.n++;
    left--;
  }

  // 4. Huecos libres: sin choques con clases ni con el horario de silencio
  const busy = new Map<number, [number, number][]>();
  for (const c of input.courses) for (const s of c.schedule) (busy.get(s.dow) ?? busy.set(s.dow, []).get(s.dow)!).push([toMin(s.time), toMin(s.time) + cfg.classMinutes]);
  const used = new Map<number, string[]>();
  const free = (dow: number, slot: string, minutes: number) => {
    const a = toMin(slot);
    const b = a + minutes;
    if ((used.get(dow)?.length ?? 0) >= cfg.maxBlocksPerDay) return false;
    if (used.get(dow)?.includes(slot)) return false;
    return !(busy.get(dow) ?? []).some(([x, y]) => a < y && b > x);
  };
  const place = (block: PlannedBlock, preferredDays: number[]): PlannedBlock | null => {
    const order = [...new Set([...preferredDays.filter((d) => cfg.days.includes(d)), ...[...cfg.days].sort((x, y) => (used.get(x)?.length ?? 0) - (used.get(y)?.length ?? 0) || x - y)])];
    for (const dow of order)
      for (const slot of cfg.slots)
        if (free(dow, slot, block.minutes)) {
          (used.get(dow) ?? used.set(dow, []).get(dow)!).push(slot);
          return { ...block, dow, start: slot };
        }
    return null;
  };

  const blocks: PlannedBlock[] = [];
  // Refuerzo primero: consiguen los mejores huecos.
  const gradeKey = (a: { c: PlanCourse }) => a.c.avgGrade ?? 99;
  for (const a of [...alloc].sort((x, y) => Number(y.refuerzo) - Number(x.refuerzo) || gradeKey(x) - gradeKey(y) || y.weight - x.weight || x.c.id.localeCompare(y.c.id))) {
    // Práctica espaciada: el día antes de cada clase del curso, luego el mismo día.
    const pref = a.c.schedule.flatMap((s) => [s.dow === 1 ? 6 : s.dow - 1, s.dow]);
    for (let i = 0; i < a.n; i++) {
      const asesoria = advisory.has(a.c.id) && i === 0;
      const b = place(
        {
          dow: 0,
          start: '',
          minutes: blockMin,
          courseId: a.c.id,
          title: asesoria ? `Asesoría de ${a.c.name}` : a.c.name,
          kind: asesoria ? 'REFUERZO' : 'ESTUDIO',
          topic: a.c.topic,
          reason: asesoria ? 'Espacio reservado para la asesoría del curso: confirma el horario oficial con tu tutor o facultad.' : a.reason,
        },
        pref.slice(i % Math.max(1, pref.length)),
      );
      if (b) blocks.push(b);
    }
  }
  for (const n of nivel) {
    const b = place(n, [6, 3]);
    if (b) blocks.push(b);
  }
  blocks.sort((x, y) => x.dow - y.dow || x.start.localeCompare(y.start));

  const priorities: CoursePriority[] = alloc
    .map((a) => ({ courseId: a.c.id, name: a.c.name, level: a.refuerzo ? ('REFUERZO' as const) : ('MANTENER' as const), minutes: blocks.filter((b) => b.courseId === a.c.id).reduce((s, b) => s + b.minutes, 0), reason: a.reason }))
    .sort(
      (x, y) =>
        Number(y.level === 'REFUERZO') - Number(x.level === 'REFUERZO') ||
        (input.courses.find((c) => c.id === x.courseId)!.avgGrade ?? 99) - (input.courses.find((c) => c.id === y.courseId)!.avgGrade ?? 99) ||
        y.minutes - x.minutes,
    );

  if (short) notes.push(`Bloques de ${blockMin} minutos para que encajen en una semana apretada. Tu plan no cambia tus créditos; si sientes que no te alcanza el tiempo, conversa con tu coordinador.`);
  if (nivel.length) notes.push('Incluimos sesiones de nivelación: cuentan dentro de tus horas de estudio.');
  if (priorities.some((p) => p.level === 'REFUERZO')) notes.push('Los cursos en refuerzo tienen más tiempo; los más comprometidos, además, una asesoría reservada.');
  if (blocks.length < targetBlocks) notes.push('No encontramos huecos para todos los bloques: revisa tu horario con tu tutor.');

  return { blocks, priorities, totalMinutes: blocks.reduce((s, b) => s + b.minutes, 0), notes };
}

export const dayName = (dow: number) => DAY_NAME[dow];

/** ¿Se puede marcar como hecho? Solo bloques de hoy o días anteriores de la semana en curso. */
export function canMarkBlock(blockDow: number, todayDow: number): boolean {
  const norm = (d: number) => (d === 0 ? 7 : d);
  return norm(blockDow) <= norm(todayDow);
}

/**
 * Al crear el plan a mitad de semana, marca como hechos los primeros bloques ya pasados hasta cubrir las horas
 * de estudio que el becario ya registró esta semana (así el plan y sus horas cuentan lo mismo).
 */
export function premarkDoneBlocks<T extends { dow: number; minutes: number }>(blocks: T[], studiedHours: number, todayDow: number): boolean[] {
  let left = Math.round(studiedHours * 60);
  const norm = (d: number) => (d === 0 ? 7 : d);
  return blocks.map((b) => {
    if (left <= 0 || norm(b.dow) >= norm(todayDow)) return false;
    left -= b.minutes;
    return true;
  });
}
