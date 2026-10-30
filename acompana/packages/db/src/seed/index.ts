/**
 * Seed SINTÉTICO: 200 becarios + 4 personas de demo (Ana, Luis, Rosa, Pedro), 3 universidades ficticias,
 * 12 regiones, 2 cohortes de reglas y equipo (coordinadores, tutores, psicólogas, mentores).
 * Ningún dato personal real. Reproducible (semilla fija). Borra y recrea todo.
 */
import { clamp, createRng, sampleLatent, sampleWeek, weekKey, type LatentStudent, type WeeklySignals } from '@acompana/domain';
import { prisma, type Prisma } from '../index';
import { DEFAULT_SETTINGS, saveSettings } from '../services/config';
import { hashPassword } from '../services/password';
import { recalcAll } from '../services/recalc';
import { CAREER_COURSES, CAREERS, CHECKLIST, COMMON_COURSES, FIRST_NAMES_F, FIRST_NAMES_M, LAST_NAMES, REGIONS, UNIVERSITIES } from './catalog';

const N_SCHOLARS = 200;
const CURRENT_WEEK = 5;
const TERM = '2026-II';
const DAY = 86_400_000;
const rng = createRng(1729);

const now = new Date();
const currentMonday = weekKey(now, 'America/Lima');
const weekStart = (n: number) => {
  const d = new Date(`${currentMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - CURRENT_WEEK) * 7);
  return d.toISOString().slice(0, 10);
};
/** Instante dentro de la semana n (día 0 = lunes) a las 15:00 UTC (10:00 Lima). */
const at = (n: number, day = 3) => new Date(new Date(`${weekStart(n)}T15:00:00Z`).getTime() + day * DAY);
const termStart = at(1, 0);

async function wipe() {
  const tables = [
    'studyBlock', 'studyPlan', 'messageEvent', 'message', 'conversation', 'alertAction', 'alert', 'riskSnapshot', 'profileSnapshot', 'moodCheckin',
    'weeklySignal', 'weeklyGoal', 'enrollment', 'course', 'scholarChecklist', 'checklistItem', 'onboardingAnswer', 'consent',
    'mentorSession', 'mentorAssignment', 'familyContact', 'scholar', 'user', 'career', 'university', 'region', 'ruleSet',
    'appConfig', 'auditLog', 'demoClock',
  ] as const;
  for (const t of tables) await (prisma[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
}

type Persona = {
  id: string;
  name: string;
  gender: 'F' | 'M';
  uni: string;
  career: string;
  origin: string;
  livesAlone: boolean;
  cohort: 'NUEVO_DS017' | 'PRE_DS017';
  /** Señales por semana 1..5 (sobrescriben el generador). */
  weeks?: Partial<WeeklySignals>[];
  nivGrade?: number;
  partialBase?: number;
  onboarding?: { careerFit: number; mood: number; math: number; reading: number } | null;
  overdue?: string[];
  persona: string;
};

const PERSONAS: Persona[] = [
  {
    id: 'sch-ana',
    name: 'Ana Torres Ramos',
    gender: 'F',
    uni: 'U1',
    career: 'CON',
    origin: 'PIU',
    livesAlone: false,
    cohort: 'NUEVO_DS017',
    nivGrade: 15.5,
    partialBase: 15.8,
    weeks: [
      { attendanceRate: 0.95, activeDays: 6, studyHours: 12, mood: 4 },
      { attendanceRate: 0.96, activeDays: 6, studyHours: 13, mood: 4 },
      { attendanceRate: 0.94, activeDays: 5, studyHours: 12, mood: 5 },
      { attendanceRate: 0.95, activeDays: 6, studyHours: 13, mood: 4, avgPartial: 15.8 },
      { attendanceRate: 0.96, activeDays: 6, studyHours: 12, mood: 4, avgPartial: 15.8 },
    ],
    onboarding: { careerFit: 5, mood: 4, math: 78, reading: 82 },
    overdue: [],
    persona: 'Ana: estable (verde). Vive con su tía; cumple metas.',
  },
  {
    id: 'sch-luis',
    name: 'Luis Ríos Pacaya',
    gender: 'M',
    uni: 'U1',
    career: 'SIS',
    origin: 'LOR',
    livesAlone: true,
    cohort: 'NUEVO_DS017',
    nivGrade: 9.5,
    partialBase: 10.4,
    weeks: [
      { attendanceRate: 0.9, activeDays: 5, studyHours: 10, mood: 4 },
      { attendanceRate: 0.86, activeDays: 4, studyHours: 9, mood: 4 },
      { attendanceRate: 0.82, activeDays: 3, studyHours: 7, mood: 3 },
      { attendanceRate: 0.78, activeDays: 2, studyHours: 6, mood: 3, avgPartial: 10.8 },
      { attendanceRate: 0.8, activeDays: 1, studyHours: 6, mood: 3, avgPartial: 10.4 },
    ],
    onboarding: { careerFit: 4, mood: 4, math: 42, reading: 58 },
    overdue: ['DEP-1', 'DEP-2', 'TRM-3'],
    persona: 'Luis: migrante de Loreto, vive solo, desaprobó Nivelación en Matemática (cohorte nueva) → rojo, integración + académica.',
  },
  {
    id: 'sch-rosa',
    name: 'Rosa Huamaní Quispe',
    gender: 'F',
    uni: 'U1',
    career: 'ENF',
    origin: 'HVC',
    livesAlone: true,
    cohort: 'PRE_DS017',
    nivGrade: 13,
    partialBase: 13.4,
    weeks: [
      { attendanceRate: 0.93, activeDays: 6, studyHours: 12, mood: 4 },
      { attendanceRate: 0.9, activeDays: 5, studyHours: 11, mood: 4 },
      { attendanceRate: 0.9, activeDays: 5, studyHours: 11, mood: 3 },
      { attendanceRate: 0.87, activeDays: 5, studyHours: 10, mood: 3, avgPartial: 13.4 },
      { attendanceRate: 0.86, activeDays: 4, studyHours: 10, mood: null, avgPartial: 13.4 },
    ],
    onboarding: { careerFit: 4, mood: 3, math: 64, reading: 70 },
    overdue: [],
    persona: 'Rosa: de Huancavelica, vive sola, ánimo en descenso; en la demo expresa malestar y se escala a psicología.',
  },
  {
    id: 'sch-pedro',
    name: 'Pedro Condori Apaza',
    gender: 'M',
    uni: 'U1',
    career: 'EDU',
    origin: 'PUN',
    livesAlone: true,
    cohort: 'NUEVO_DS017',
    onboarding: null,
    persona: 'Pedro: recién adjudicado, sin onboarding (para mostrar el día cero).',
  },
];

async function main() {
  console.log('Limpiando base…');
  await wipe();

  await saveSettings(DEFAULT_SETTINGS);
  await prisma.demoClock.create({ data: { id: 1, weekNumber: CURRENT_WEEK, offsetDays: 0 } });

  await prisma.region.createMany({ data: REGIONS.map(([id, name]) => ({ id, name })) });
  await prisma.university.createMany({ data: UNIVERSITIES.map((u) => ({ ...u })) });
  await prisma.career.createMany({
    data: UNIVERSITIES.flatMap((u) => CAREERS.map(([c, name]) => ({ id: `${u.id}-${c}`, name, universityId: u.id }))),
  });

  // Reglas por cohorte (DS 017-2026-MINEDU). Valores configurables; contrastar con el texto oficial.
  await prisma.ruleSet.createMany({
    data: [
      {
        id: 'rs-nuevo',
        code: 'NUEVO_DS017',
        name: 'Becarios adjudicados desde la vigencia del DS 017-2026-MINEDU',
        legalRef: 'DS 017-2026-MINEDU',
        passingGrade: 11,
        gpaWarningMargin: 1.5,
        minCreditsPerTerm: 20,
        requireTopThird: true,
        failRuleApplies: true,
        maxFailedCourses: 2,
        awardedFrom: new Date('2026-09-25T05:00:00Z'),
      },
      {
        id: 'rs-pre',
        code: 'PRE_DS017',
        name: 'Becarios adjudicados antes del DS 017-2026-MINEDU',
        legalRef: 'DS 017-2026-MINEDU (causal de desaprobados no aplica)',
        passingGrade: 11,
        gpaWarningMargin: 1.5,
        minCreditsPerTerm: 20,
        requireTopThird: true,
        failRuleApplies: false,
        maxFailedCourses: 2,
        awardedUntil: new Date('2026-09-25T04:59:59Z'),
      },
    ],
  });

  // Cursos con horario (lun–vie) y temas por semana
  const rooms = ['A-101', 'A-201', 'B-104', 'B-305', 'C-210', 'Lab-2', 'Aula Virtual'];
  const courses: Prisma.CourseCreateManyInput[] = [];
  for (const u of UNIVERSITIES)
    for (const [c] of CAREERS) {
      // Horario sin choques: 20 franjas (lun–vie × 4 horas); el curso j toma las franjas j y j+12 (dos días distintos).
      const times = ['08:00', '10:00', '14:00', '16:00'];
      const slot = (k: number) => ({ dow: (k % 5) + 1, time: times[Math.floor(k / 5)], room: rooms[k % rooms.length] });
      let j = 0;
      [...COMMON_COURSES, ...CAREER_COURSES[c]].forEach((t) => {
        const schedule = t.code === 'NIV' ? [] : [slot(j), slot(j + 12)];
        if (t.code !== 'NIV') j++;
        courses.push({
          id: `${u.id}-${c}-${t.code}`,
          name: t.name,
          credits: t.credits,
          careerId: `${u.id}-${c}`,
          schedule,
          weeklyTopics: t.topics,
        });
      });
    }
  await prisma.course.createMany({ data: courses });
  await prisma.checklistItem.createMany({ data: CHECKLIST });

  // Equipo por universidad
  const staff: Prisma.UserCreateManyInput[] = [
    { id: 'usr-pronabec', name: 'Carmen Rojas (Pronabec)', email: 'coordinacion@pronabec.ejemplo.test', role: 'COORDINADOR', isDemo: true },
  ];
  const STAFF_NAMES: Record<string, string[]> = {
    U1: ['Jorge Salas', 'Marco Paredes', 'Lucía Fernández'],
    U2: ['Patricia Valdivia', 'Raúl Cornejo', 'Elena Zegarra'],
    U3: ['Hugo Alvarado', 'Gloria Benites', 'Teresa Lozano'],
  };
  for (const u of UNIVERSITIES) {
    const [coord, tutor, psy] = STAFF_NAMES[u.id];
    const dom = `${u.id.toLowerCase()}.ejemplo.test`;
    staff.push(
      { id: `usr-${u.id}-coord`, name: coord, email: `coordinacion@${dom}`, role: 'COORDINADOR', universityId: u.id, isDemo: u.id === 'U1' },
      { id: `usr-${u.id}-tutor`, name: tutor, email: `tutoria@${dom}`, role: 'TUTOR', specialty: 'ACADEMICO', universityId: u.id, isDemo: u.id === 'U1' },
      { id: `usr-${u.id}-psico`, name: psy, email: `psicologia@${dom}`, role: 'TUTOR', specialty: 'PSICOLOGIA', universityId: u.id, isDemo: u.id === 'U1' },
    );
  }
  // Mentores pares (estudiantes de ciclos avanzados), con región de origen y carrera
  const MENTORS: [string, string, string, string][] = [
    ['U1', 'Diego Huamán Tapullima', 'LOR', 'SIS'],
    ['U1', 'Nayeli Ccama Ticona', 'PUN', 'ENF'],
    ['U1', 'Wilmer Apaza Cruz', 'CUS', 'EDU'],
    ['U1', 'Ruth Salazar Ayala', 'HVC', 'CON'],
    ['U2', 'Flor Condori Mamani', 'PUN', 'ENF'],
    ['U2', 'Elmer Yupanqui Ramos', 'CUS', 'SIS'],
    ['U2', 'Milagros Ccahuana Rojas', 'APU', 'EDU'],
    ['U3', 'Kevin Chávez Tello', 'CAJ', 'SIS'],
    ['U3', 'Yesenia Flores Peña', 'PIU', 'CON'],
    ['U3', 'Percy Ramos Inga', 'AYA', 'ENF'],
  ];
  MENTORS.forEach(([u, name, region, career], i) =>
    staff.push({
      id: `usr-mentor-${i + 1}`,
      name,
      email: `mentor${i + 1}@${u.toLowerCase()}.ejemplo.test`,
      role: 'MENTOR',
      universityId: u,
      regionId: region,
      careerId: `${u}-${career}`,
      isDemo: name.startsWith('Diego') || name.startsWith('Ruth'),
    }),
  );
  await prisma.user.createMany({ data: staff });

  // Becarios sintéticos + personas
  const people: Persona[] = [...PERSONAS];
  for (let i = 1; i <= N_SCHOLARS; i++) {
    const gender = rng.chance(0.52) ? 'F' : 'M';
    const uni = rng.pick(UNIVERSITIES);
    const migrant = rng.chance(0.6);
    const origin = migrant ? rng.pick(REGIONS.filter(([r]) => r !== uni.regionId))[0] : uni.regionId;
    people.push({
      id: `sch-${String(i).padStart(3, '0')}`,
      name: `${rng.pick(gender === 'F' ? FIRST_NAMES_F : FIRST_NAMES_M)} ${rng.pick(LAST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      gender,
      uni: uni.id,
      career: rng.pick(CAREERS)[0],
      origin,
      livesAlone: migrant ? rng.chance(0.55) : rng.chance(0.1),
      cohort: rng.chance(0.55) ? 'NUEVO_DS017' : 'PRE_DS017',
      persona: 'sintético',
    });
  }

  const users: Prisma.UserCreateManyInput[] = [];
  const scholars: Prisma.ScholarCreateManyInput[] = [];
  const consents: Prisma.ConsentCreateManyInput[] = [];
  const onboardings: Prisma.OnboardingAnswerCreateManyInput[] = [];
  const checklists: Prisma.ScholarChecklistCreateManyInput[] = [];
  const enrollments: Prisma.EnrollmentCreateManyInput[] = [];
  const signals: Prisma.WeeklySignalCreateManyInput[] = [];
  const moods: Prisma.MoodCheckinCreateManyInput[] = [];
  const goals: Prisma.WeeklyGoalCreateManyInput[] = [];
  const convs: Prisma.ConversationCreateManyInput[] = [];
  const mentorships: Prisma.MentorAssignmentCreateManyInput[] = [];
  const st = DEFAULT_SETTINGS.consentTexts;

  people.forEach((p, idx) => {
    const latent: LatentStudent = sampleLatent(rng);
    if (p.id === 'sch-ana') Object.assign(latent, { academic: 0.85, engagement: 0.9, wellbeing: 0.85, timePressure: 0.15, studyHoursTarget: 12 });
    if (p.id === 'sch-luis') Object.assign(latent, { academic: 0.45, engagement: 0.4, wellbeing: 0.55, timePressure: 0.4, studyHoursTarget: 12 });
    if (p.id === 'sch-rosa') Object.assign(latent, { academic: 0.65, engagement: 0.7, wellbeing: 0.35, timePressure: 0.25, studyHoursTarget: 12 });
    const uniRegion = UNIVERSITIES.find((u) => u.id === p.uni)!.regionId;
    const away = p.origin !== uniRegion;
    const isNew = p.cohort === 'NUEVO_DS017';
    const userId = `usr-${p.id}`;
    const awardedAt = isNew ? new Date(Date.UTC(2026, 8, 25 + rng.int(0, 2), 15)) : new Date(Date.UTC(2026, rng.int(2, 7), rng.int(1, 28), 15));
    const credits = p.persona === 'sintético' && rng.chance(0.03) ? 18 : 22;

    users.push({ id: userId, name: p.name, email: `${p.id}@becarios.ejemplo.test`, role: 'BECARIO', universityId: p.uni, isDemo: p.persona !== 'sintético' });
    scholars.push({
      id: p.id,
      userId,
      ruleSetId: isNew ? 'rs-nuevo' : 'rs-pre',
      universityId: p.uni,
      careerId: `${p.uni}-${p.career}`,
      originRegionId: p.origin,
      livesAlone: p.livesAlone,
      awardedAt,
      phoneE164: `+5190000${String(idx).padStart(4, '0')}`,
      enrolledCredits: credits,
      cohortPercentile: null,
      onboardingDoneAt: p.onboarding === null ? null : termStart,
      persona: p.persona,
      synthLatent: latent as unknown as Prisma.InputJsonValue,
    });
    convs.push({ scholarId: p.id, lastInboundAt: p.persona === 'sintético' && rng.chance(0.4) ? new Date(now.getTime() - rng.between(1, 60) * 3600_000) : null });
    if (p.id === 'sch-pedro') return; // día cero: sin datos aún

    // Onboarding y consentimientos
    const ob = p.onboarding ?? {
      careerFit: Math.round(clamp(rng.normal(3.8 + (latent.engagement - 0.65) * 3, 0.8), 1, 5)),
      mood: Math.round(clamp(rng.normal(2 + 3 * latent.wellbeing, 0.6), 1, 5)),
      math: Math.round(clamp(rng.normal(25 + 65 * latent.academic, 8), 0, 100)),
      reading: Math.round(clamp(rng.normal(30 + 60 * latent.academic, 8), 0, 100)),
    };
    onboardings.push({ scholarId: p.id, careerFit: ob.careerFit, mood: ob.mood, mathScore: ob.math, readingScore: ob.reading, studiesAwayFromHome: away, createdAt: termStart });
    consents.push({ scholarId: p.id, type: 'DATOS_LEY_29733', textVersion: st.DATOS_LEY_29733.version, textSnapshot: st.DATOS_LEY_29733.text, channel: 'web-onboarding', acceptedAt: termStart });
    if (p.persona !== 'sintético' || rng.chance(0.85)) {
      consents.push({ scholarId: p.id, type: 'WHATSAPP', textVersion: st.WHATSAPP.version, textSnapshot: st.WHATSAPP.text, channel: 'web-onboarding', acceptedAt: termStart });
    }

    // Kit de llegada
    for (const item of CHECKLIST) {
      const due = new Date(termStart.getTime() + item.dueDays * DAY);
      let doneAt: Date | null;
      if (p.overdue) doneAt = p.overdue.includes(item.id) ? null : new Date(due.getTime() - DAY);
      else doneAt = rng.chance(0.62 + 0.4 * latent.engagement) ? new Date(due.getTime() - rng.int(0, 3) * DAY) : null;
      checklists.push({ scholarId: p.id, itemId: item.id, dueDate: due, doneAt });
    }

    // Matrícula: nivelación (cerrada en semana 4) + cursos del ciclo
    const tpls = [...COMMON_COURSES, ...CAREER_COURSES[p.career]];
    const niv = p.nivGrade ?? Math.round(clamp(6 + 9 * latent.academic + 3 * latent.engagement + rng.normal(0, 1.2), 0, 20) * 10) / 10;
    const nivFailed = niv < 11 ? 1 : 0;
    const partialBase = p.partialBase ?? clamp(6 + 9 * latent.academic + 3 * latent.engagement + rng.normal(0, 1.2), 0, 20);
    for (const t of tpls) {
      const courseId = `${p.uni}-${p.career}-${t.code}`;
      if (t.code === 'NIV') {
        enrollments.push({ scholarId: p.id, courseId, term: TERM, partialGrades: [niv], finalGrade: niv, status: nivFailed ? 'DESAPROBADO' : 'APROBADO' });
      } else {
        const g = Math.round(clamp(partialBase + rng.normal(0, 1.3), 0, 20) * 10) / 10;
        enrollments.push({ scholarId: p.id, courseId, term: TERM, partialGrades: [g], status: 'EN_CURSO' });
      }
    }

    // Señales semanales 1..5, metas y check-ins
    for (let w = 1; w <= CURRENT_WEEK; w++) {
      const gen = sampleWeek(latent, w, rng, w >= 5 ? nivFailed : 0);
      const ov = p.weeks?.[w - 1] ?? {};
      const sig: WeeklySignals = { ...gen, ...ov, failedAttempts: w >= 5 ? nivFailed : 0, studyHoursTarget: latent.studyHoursTarget };
      if (w < 4) sig.avgPartial = null;
      else if (ov.avgPartial === undefined) sig.avgPartial = Math.round(partialBase * 10) / 10;
      signals.push({ scholarId: p.id, weekStart: weekStart(w), weekNumber: w, ...sig });
      if (sig.mood !== null) moods.push({ scholarId: p.id, score: sig.mood, channel: 'whatsapp', level: 'NINGUNO', createdAt: at(w, 3) });
      const weekly = tpls.filter((t) => t.code !== 'NIV' || w <= 4);
      goals.push({
        scholarId: p.id,
        weekStart: weekStart(w),
        attendanceTarget: 0.9,
        studyHoursTarget: latent.studyHoursTarget,
        courseGoals: weekly.map((t) => {
          const target = Math.max(1, Math.round((latent.studyHoursTarget * t.credits) / 22));
          return {
            courseId: `${p.uni}-${p.career}-${t.code}`,
            name: t.name,
            topic: t.topics[String(w)] ?? null,
            target,
            done: Math.round(clamp((sig.studyHours / latent.studyHoursTarget) * target + rng.normal(0, 0.4), 0, target * 1.5) * 10) / 10,
            reinforcement: partialBase < 12.5 && t.code !== 'MET',
          };
        }),
      });
    }
  });

  // Mentores: mismo campus; prioridad región de origen, luego carrera
  const mentorUsers = staff.filter((u) => u.role === 'MENTOR');
  for (const s of scholars) {
    const ob = onboardings.find((o) => o.scholarId === s.id);
    if (!ob?.studiesAwayFromHome && s.id !== 'sch-pedro') continue;
    const pool = mentorUsers.filter((m) => m.universityId === s.universityId);
    const m = pool.find((x) => x.regionId === s.originRegionId) ?? pool.find((x) => x.careerId === s.careerId) ?? pool[0];
    if (m) {
      const why = m.regionId === s.originRegionId ? 'Misma región de origen' : m.careerId === s.careerId ? 'Misma carrera' : 'Mismo campus';
      mentorships.push({ mentorId: m.id!, scholarId: s.id!, reason: why, createdAt: termStart });
    }
  }

  await prisma.user.createMany({ data: users });
  await prisma.scholar.createMany({ data: scholars });
  await prisma.onboardingAnswer.createMany({ data: onboardings });
  await prisma.consent.createMany({ data: consents });
  await prisma.scholarChecklist.createMany({ data: checklists });
  await prisma.enrollment.createMany({ data: enrollments });
  await prisma.weeklySignal.createMany({ data: signals });
  await prisma.moodCheckin.createMany({ data: moods });
  await prisma.weeklyGoal.createMany({ data: goals });
  await prisma.conversation.createMany({ data: convs });
  await prisma.mentorAssignment.createMany({ data: mentorships });

  // Cuentas de prueba: DNI ficticio (rango 9900xxxx, no asignado a personas reales en estos datos) + contraseña cifrada.
  const demoPassword = process.env.DEMO_PASSWORD ?? 'Acompana2026';
  const DEMO_DNI: Record<string, string> = {
    'usr-sch-ana': '99000101',
    'usr-sch-luis': '99000102',
    'usr-sch-rosa': '99000103',
    'usr-sch-pedro': '99000104',
    'usr-pronabec': '99000201',
    'usr-U1-coord': '99000202',
    'usr-U1-tutor': '99000203',
    'usr-U1-psico': '99000204',
    'usr-mentor-1': '99000301',
    'usr-mentor-4': '99000302',
  };
  for (const [userId, dni] of Object.entries(DEMO_DNI)) {
    await prisma.user.update({ where: { id: userId }, data: { dni, passwordHash: hashPassword(demoPassword) } });
  }

  // Percentil en la cohorte de su carrera (por promedio de parciales)
  const byCareer = new Map<string, { id: string; avg: number }[]>();
  for (const s of scholars) {
    const g = enrollments.filter((e) => e.scholarId === s.id && e.status === 'EN_CURSO').map((e) => (e.partialGrades as number[])[0]);
    if (!g.length) continue;
    const list = byCareer.get(s.careerId) ?? [];
    list.push({ id: s.id!, avg: g.reduce((a, b) => a + b, 0) / g.length });
    byCareer.set(s.careerId, list);
  }
  for (const list of byCareer.values()) {
    list.sort((a, b) => a.avg - b.avg);
    for (const [i, x] of list.entries()) {
      await prisma.scholar.update({ where: { id: x.id }, data: { cohortPercentile: list.length > 1 ? i / (list.length - 1) : 1 } });
    }
  }

  console.log(`Creados ${scholars.length} becarios (${N_SCHOLARS} sintéticos + ${PERSONAS.length} de demo) y ${staff.length} personas del equipo.`);
  console.log('Recalculando semáforo, perfiles y alertas de la semana actual…');
  const r = await recalcAll();
  console.log(r);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
