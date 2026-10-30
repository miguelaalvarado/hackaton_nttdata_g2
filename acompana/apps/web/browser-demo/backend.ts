/**
 * Backend en memoria para la versión navegador de la demo (sin servidor).
 * Reproduce las rutas de apps/api con la MISMA lógica de dominio (packages/domain), el asistente simulado
 * (MockProvider), el catálogo de plantillas y SimulatorChannel. Los datos son sintéticos y se guardan solo
 * en el navegador de quien prueba.
 */
import {
  addHours,
  backoffDelayMs,
  buildAlerts,
  buildStudyPlan,
  canMarkBlock,
  isLocked,
  isValidDni,
  normalizeDni,
  premarkDoneBlocks,
  registerAttempt,
  type LoginAttemptState,
  type PlanCourse,
  clamp,
  computeRisk,
  createRng,
  detectCrisis,
  detectProfiles,
  evaluateScholarshipRules,
  isWindowOpen,
  normalizeText,
  parseInbound,
  policyGate,
  registerFirstAction,
  riskModel,
  sampleWeek,
  shouldRetry,
  slaStatus,
  weekKey,
  zonedParts,
  type AlertDraft,
  type ConversationState,
  type LatentStudent,
  type LogisticModel,
  type OutboundIntent,
  type Owner,
  type RuleSetConfig,
  type WeeklySignals,
} from '@acompana/domain';
import { MockProvider } from '../../../packages/llm/src/mock';
import { ASSISTANT_SYSTEM_PROMPT, ASSISTANT_TOOLS } from '../../../packages/llm/src/prompt';
import type { ChatTurn, ToolCall } from '../../../packages/llm/src/types';
import { renderTemplate, TEMPLATE_CATALOG } from '../../../packages/messaging/src/templates';
import { SimulatorChannel } from '../../../packages/messaging/src/simulator';
import { publicDiagnostic, scoreDiagnostic } from '../../api/src/diagnostic';
import snapshotJson from './snapshot.json';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
type Db = Row & { snapshotAt: string; demoClock: Row; settings: any; loadedAt: number; seq: number };

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthUser {
  sub: string;
  name: string;
  role: 'BECARIO' | 'MENTOR' | 'TUTOR' | 'COORDINADOR';
  specialty: 'ACADEMICO' | 'PSICOLOGIA' | null;
  universityId: string | null;
  scholarId: string | null;
}

const STORAGE_KEY = 'acompana.browser-demo.v1';
const DAY = 86_400_000;
/** El reloj de la demo avanza con el tiempo real, con tope, para que los datos sigan coherentes si vuelves días después. */
const MAX_REAL_ELAPSED = 6 * 3600_000;

let db: Db = load();
let persistOk = true;

function fresh(): Db {
  return { ...(structuredClone(snapshotJson) as unknown as Db), loadedAt: Date.now(), seq: 0 };
}
function load(): Db {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.snapshotAt === (snapshotJson as Row).snapshotAt) return parsed;
    }
  } catch {
    /* sin almacenamiento: se trabaja en memoria */
  }
  return fresh();
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    persistOk = true;
  } catch {
    persistOk = false;
  }
}
export function resetDemo() {
  db = fresh();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada */
  }
}
export function storageStatus() {
  return { persisted: persistOk };
}

const id = (p: string) => `${p}-${Date.now().toString(36)}-${(db.seq++).toString(36)}`;
const d = (x: string | null | undefined) => (x ? new Date(x) : null);
const iso = (x: Date) => x.toISOString();

function demoNow(): Date {
  const elapsed = Math.min(Date.now() - db.loadedAt, MAX_REAL_ELAPSED);
  return new Date(new Date(db.snapshotAt).getTime() + db.demoClock.offsetDays * DAY + elapsed);
}
function currentWeek() {
  const now = demoNow();
  return { now, weekNumber: db.demoClock.weekNumber, weekStart: weekKey(now, 'America/Lima') };
}

/* ---------- consultas básicas ---------- */
const byId = <T extends Row>(rows: T[], key: string) => rows.find((r) => r.id === key);
const scholar = (sid: string) => {
  const s = byId(db.scholars as Row[], sid);
  if (!s) throw new HttpError(404, 'NO_ENCONTRADO', 'Becario no encontrado');
  return s;
};
const userOf = (uid: string) => byId(db.users as Row[], uid)!;
const ruleSet = (s: Row) => byId(db.ruleSets as Row[], s.ruleSetId)!;
const university = (uid: string) => byId(db.universities as Row[], uid)!;
const career = (cid: string) => byId(db.careers as Row[], cid)!;
const region = (rid: string) => byId(db.regions as Row[], rid)!;
const course = (cid: string) => byId(db.courses as Row[], cid)!;

function inScope(u: AuthUser, s: Row): boolean {
  if (u.role === 'BECARIO') return s.id === u.scholarId;
  if (u.role === 'MENTOR') return db.mentorAssignments.some((m: Row) => m.mentorId === u.sub && m.scholarId === s.id && m.active);
  return u.universityId ? s.universityId === u.universityId : true;
}
function assertCanSee(u: AuthUser, sid: string) {
  if (!inScope(u, scholar(sid))) throw new HttpError(403, 'SIN_PERMISO', 'No tienes acceso a este becario.');
}
function requireRole(u: AuthUser | null, ...roles: AuthUser['role'][]): AuthUser {
  if (!u) throw new HttpError(401, 'NO_AUTENTICADO', 'Inicia sesión.');
  if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'SIN_PERMISO', 'Tu rol no tiene acceso a este recurso.');
  return u;
}

const toRuleConfig = (r: Row): RuleSetConfig => ({
  code: r.code,
  name: r.name,
  legalRef: r.legalRef,
  passingGrade: r.passingGrade,
  gpaWarningMargin: r.gpaWarningMargin,
  minCreditsPerTerm: r.minCreditsPerTerm,
  requireTopThird: r.requireTopThird,
  failRuleApplies: r.failRuleApplies,
  maxFailedCourses: r.maxFailedCourses,
});
const toSignals = (s: Row): WeeklySignals => ({
  attendanceRate: s.attendanceRate,
  activeDays: s.activeDays,
  studyHours: s.studyHours,
  studyHoursTarget: s.studyHoursTarget,
  avgPartial: s.avgPartial,
  failedAttempts: s.failedAttempts,
  mood: s.mood,
});

function rulesStatus(sid: string) {
  const s = scholar(sid);
  const rs = ruleSet(s);
  const enr = db.enrollments.filter((e: Row) => e.scholarId === sid);
  let wSum = 0;
  let cSum = 0;
  for (const e of enr) {
    const c = course(e.courseId);
    const g = e.finalGrade ?? (e.partialGrades.length ? e.partialGrades.reduce((a: number, b: number) => a + b, 0) / e.partialGrades.length : null);
    if (g !== null) {
      wSum += g * c.credits;
      cSum += c.credits;
    }
  }
  const rules = evaluateScholarshipRules(toRuleConfig(rs), {
    weightedAverage: cSum ? Math.round((wSum / cSum) * 10) / 10 : null,
    termClosed: false,
    enrolledCredits: s.enrolledCredits,
    cohortPercentile: s.cohortPercentile,
    failedAttempts: enr.filter((e: Row) => e.status === 'DESAPROBADO').length,
  });
  return { cohort: rs.name, legalRef: rs.legalRef, rules };
}

/* ---------- recálculo, perfiles y alertas ---------- */
function resolveAssignee(owner: Owner | null, sid: string, universityId: string): string | null {
  if (!owner) return null;
  if (owner.role === 'MENTOR') {
    const m = db.mentorAssignments.find((x: Row) => x.scholarId === sid && x.active);
    if (m) return m.mentorId;
  }
  const u = db.users.find(
    (x: Row) => x.role === owner.role && x.universityId === universityId && (owner.role !== 'TUTOR' || x.specialty === owner.specialty),
  );
  return u?.id ?? null;
}

function upsertAlert(dft: AlertDraft, s: Row, now: Date, source: string): boolean {
  const existing = db.alerts.find((a: Row) => a.dedupeKey === dft.dedupeKey);
  if (existing) {
    if (existing.severity !== 'ROJO' && dft.severity === 'ROJO' && existing.status !== 'CERRADA') {
      Object.assign(existing, { severity: 'ROJO', dueAt: dft.dueAt && iso(dft.dueAt), reason: dft.reason, source, firstActionAt: null, slaMet: null, status: 'ABIERTA' });
      return true;
    }
    return false;
  }
  (db.alerts as Row[]).push({
    id: id('alert'),
    dedupeKey: dft.dedupeKey,
    scholarId: s.id,
    direction: dft.direction,
    severity: dft.severity,
    profile: dft.profile,
    reason: dft.reason,
    nextStep: dft.nextStep,
    assigneeId: resolveAssignee(dft.owner, s.id, s.universityId),
    status: 'ABIERTA',
    source,
    dueAt: dft.dueAt ? iso(dft.dueAt) : null,
    firstActionAt: null,
    slaMet: null,
    createdAt: iso(now),
    closedAt: null,
  });
  return true;
}

function recalcScholar(sid: string, source = 'RECALCULO_SEMANAL') {
  const settings = db.settings;
  const { weekStart, now } = currentWeek();
  const s = scholar(sid);
  const signals = db.weeklySignals.filter((x: Row) => x.scholarId === sid && x.weekStart <= weekStart).sort((a: Row, b: Row) => (a.weekStart < b.weekStart ? 1 : -1));
  const [current, previous] = signals;
  if (!current) return { scholarId: sid, color: 'SIN_DATOS', profiles: [] as string[], alertsCreated: 0 };
  const moods = db.moodCheckins
    .filter((m: Row) => m.scholarId === sid && m.score !== null)
    .sort((a: Row, b: Row) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 4);
  const overdue = db.scholarChecklists.filter((c: Row) => c.scholarId === sid && !c.doneAt && new Date(c.dueDate) < now).length;
  const weekAgo = now.getTime() - 7 * DAY;
  const levels = db.moodCheckins.filter((m: Row) => m.scholarId === sid && new Date(m.createdAt).getTime() >= weekAgo && (m.level === 'MALESTAR' || m.level === 'CRISIS'));
  const crisis = levels.some((l: Row) => l.level === 'CRISIS');
  const ob = db.onboardings.find((o: Row) => o.scholarId === sid);
  const rules = toRuleConfig(ruleSet(s));
  const sig = toSignals(current);
  const risk = computeRisk({ signals: sig, rules, crisis }, riskModel as LogisticModel, settings.riskThresholds);
  const profiles = detectProfiles(
    {
      current: sig,
      previous: previous ? toSignals(previous) : null,
      recentMoods: moods.map((m: Row) => m.score),
      rules,
      onboarding: {
        careerFit: ob?.careerFit ?? null,
        mathScore: ob?.mathScore ?? null,
        readingScore: ob?.readingScore ?? null,
        livesAlone: s.livesAlone,
        studiesAwayFromHome: ob?.studiesAwayFromHome ?? s.originRegionId !== university(s.universityId).regionId,
      },
      overdueChecklistItems: overdue,
      lifeEventReported: s.lifeEventReported,
      distressLanguage: levels.length > 0,
      crisis,
    },
    settings.profileThresholds,
  );
  db.riskSnapshots = db.riskSnapshots.filter((r: Row) => !(r.scholarId === sid && r.weekStart === weekStart));
  db.profileSnapshots = db.profileSnapshots.filter((r: Row) => !(r.scholarId === sid && r.weekStart === weekStart));
  (db.riskSnapshots as Row[]).push({
    id: id('risk'),
    scholarId: sid,
    weekStart,
    color: risk.color,
    probability: risk.probability,
    reasons: risk.reasons,
    rulesFired: risk.rulesFired,
    modelVersion: risk.modelVersion,
    createdAt: iso(now),
  });
  (db.profileSnapshots as Row[]).push({
    id: id('prof'),
    scholarId: sid,
    weekStart,
    profiles: profiles.profiles,
    primary: profiles.primary,
    evidence: profiles.evidence,
    createdAt: iso(now),
  });
  let created = 0;
  for (const dft of buildAlerts({ scholarId: sid, weekKey: weekStart, risk, profiles, now, sla: settings.sla })) {
    if (upsertAlert(dft, s, now, source)) created++;
  }
  return { scholarId: sid, color: risk.color, profiles: profiles.profiles as string[], alertsCreated: created };
}

function recalcAll() {
  const byColor: Record<string, number> = {};
  let alertsCreated = 0;
  for (const s of db.scholars) {
    const r = recalcScholar(s.id);
    byColor[r.color] = (byColor[r.color] ?? 0) + 1;
    alertsCreated += r.alertsCreated;
  }
  return { total: db.scholars.length, byColor, alertsCreated };
}

function addAlertAction(alertId: string, actorId: string, type: string, note: string) {
  const now = demoNow();
  const a = db.alerts.find((x: Row) => x.id === alertId);
  if (!a) throw new HttpError(404, 'NO_ENCONTRADO', 'Alerta no encontrada');
  const first = registerFirstAction({ dueAt: d(a.dueAt), firstActionAt: d(a.firstActionAt), slaMet: a.slaMet }, now);
  (db.alertActions as Row[]).push({ id: id('act'), alertId, actorId, type, note, at: iso(now) });
  const close = type === 'CIERRE';
  Object.assign(a, { firstActionAt: iso(first.firstActionAt), slaMet: first.slaMet, status: close ? 'CERRADA' : 'EN_ATENCION', closedAt: close ? iso(now) : null });
}

/* ---------- mensajería (misma puerta de políticas que la API) ---------- */
const channel = new SimulatorChannel((e) => {
  const m = db.messages.find((x: Row) => x.providerMessageId === e.providerMessageId);
  if (m && m.status === 'ENVIADO' && e.status === 'delivered') {
    m.status = 'ENTREGADO';
    save();
  }
});

function conversation(sid: string): Row {
  let c = db.conversations.find((x: Row) => x.scholarId === sid);
  if (!c) {
    c = { id: id('conv'), scholarId: sid, lastInboundAt: null, optedOutAt: null, optOutConfirmed: false };
    (db.conversations as Row[]).push(c);
  }
  return c;
}

function conversationState(sid: string): ConversationState {
  const c = conversation(sid);
  const optIn = db.consents.some((x: Row) => x.scholarId === sid && x.type === 'WHATSAPP' && !x.revokedAt);
  const sent = db.messages.filter((m: Row) => m.conversationId === c.id && m.initiator === 'PLATFORM' && ['ENVIADO', 'ENTREGADO', 'LEIDO'].includes(m.status) && m.sentAt);
  return { optIn, optedOutAt: d(c.optedOutAt), lastInboundAt: d(c.lastInboundAt), platformSentAt: sent.map((m: Row) => new Date(m.sentAt)), optOutConfirmed: c.optOutConfirmed };
}

async function sendToScholar(req: { scholarId: string; intent: OutboundIntent; text?: string; templateParams?: string[] }) {
  const c = conversation(req.scholarId);
  const tpl = req.intent.templateName ? TEMPLATE_CATALOG[req.intent.templateName] : undefined;
  const body = req.intent.kind === 'TEMPLATE' && tpl ? renderTemplate(tpl, req.templateParams ?? []) : (req.text ?? '');
  const msg: Row = {
    id: id('msg'),
    conversationId: c.id,
    direction: 'OUT',
    initiator: req.intent.initiator,
    kind: req.intent.kind,
    templateName: req.intent.templateName ?? null,
    templateParams: req.templateParams ?? [],
    category: tpl?.category ?? null,
    body,
    status: 'PROGRAMADO',
    channel: channel.name,
    providerMessageId: null,
    policyDecision: null,
    errorCode: null,
    errorClass: null,
    attempts: 0,
    scheduledFor: null,
    sentAt: null,
    createdAt: iso(demoNow()),
  };
  (db.messages as Row[]).push(msg);
  return deliverMessage(msg);
}

async function deliverMessage(msg: Row) {
  if (msg.status !== 'PROGRAMADO') return msg;
  const now = demoNow();
  const c = db.conversations.find((x: Row) => x.id === msg.conversationId)!;
  const intent: OutboundIntent = { initiator: msg.initiator, kind: msg.kind, templateName: msg.templateName ?? undefined };
  const decision = policyGate(intent, conversationState(c.scholarId), TEMPLATE_CATALOG, now, db.settings.messaging);
  if (decision.decision === 'REJECT') return Object.assign(msg, { status: 'BLOQUEADO', policyDecision: decision.reason });
  if (decision.decision === 'DEFER') return Object.assign(msg, { policyDecision: decision.reason, scheduledFor: iso(decision.until) });

  const tpl = msg.templateName ? TEMPLATE_CATALOG[msg.templateName] : undefined;
  const attempts = msg.attempts + 1;
  const result = await channel.send({
    clientRef: msg.id,
    to: c.scholarId,
    kind: intent.kind,
    text: intent.kind === 'FREE' ? msg.body : undefined,
    template: tpl ? { name: tpl.name, language: tpl.language, params: msg.templateParams } : undefined,
  });
  if (result.ok) {
    if (msg.initiator === 'OPT_OUT_CONFIRMATION') c.optOutConfirmed = true;
    return Object.assign(msg, { status: 'ENVIADO', providerMessageId: result.providerMessageId, sentAt: iso(now), attempts, policyDecision: 'ALLOW', errorCode: null });
  }
  if (shouldRetry(result.error, attempts, db.settings.maxSendAttempts)) {
    return Object.assign(msg, { attempts, errorCode: result.error.code, errorClass: result.error.class, scheduledFor: iso(new Date(now.getTime() + backoffDelayMs(attempts))) });
  }
  return Object.assign(msg, { status: 'FALLIDO', attempts, errorCode: result.error.code, errorClass: result.error.class });
}

/** Entrega los mensajes diferidos cuya hora ya llegó (equivale al worker). */
async function deliverDue() {
  const now = demoNow().toISOString();
  for (const m of db.messages.filter((x: Row) => x.status === 'PROGRAMADO' && x.scheduledFor && x.scheduledFor <= now)) await deliverMessage(m);
}

/* ---------- asistente (mismo pipeline que la API) ---------- */
const provider = new MockProvider();
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function toolRunner(sid: string, effects: { humanRequested: { reason: string; team: string } | null; moodLogged: number | null }) {
  return async (call: ToolCall): Promise<string> => {
    const { now, weekStart } = currentWeek();
    switch (call.name) {
      case 'get_schedule': {
        const days = Math.min(Number(call.input.days ?? 2), 7);
        const p = zonedParts(now, 'America/Lima');
        const today = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
        const sessions = db.enrollments
          .filter((e: Row) => e.scholarId === sid && e.status === 'EN_CURSO')
          .flatMap((e: Row) => {
            const c = course(e.courseId);
            return (c.schedule as Row[]).map((x) => ({ course: c.name, offset: (x.dow - today + 7) % 7, day: DAYS[x.dow], time: x.time, room: x.room }));
          })
          .filter((x: Row) => x.offset < days)
          .sort((a: Row, b: Row) => a.offset - b.offset || a.time.localeCompare(b.time));
        return JSON.stringify({ sessions });
      }
      case 'get_weekly_goals': {
        const goal = latestGoal(sid);
        const sig = db.weeklySignals.find((x: Row) => x.scholarId === sid && x.weekStart === weekStart);
        const courses = ((goal?.courseGoals ?? []) as Row[]).map((c) => ({ ...c, progress: c.target ? Math.min(c.done / c.target, 1) : 1 }));
        const plan = ensureStudyPlan(sid);
        const today = todayDow();
        const nb = plan ? planBlocks(plan.id).find((b) => !b.doneAt && normDow(b.dow) >= normDow(today)) : undefined;
        const nextBlock = nb ? { title: nb.title, day: DAYS[nb.dow], isToday: nb.dow === today, start: nb.start, minutes: nb.minutes, topic: nb.topic } : null;
        return JSON.stringify({ nextBlock, attendanceTarget: goal?.attendanceTarget, attendance: sig?.attendanceRate, studyHoursTarget: goal?.studyHoursTarget ?? sig?.studyHoursTarget, studyHours: sig?.studyHours ?? 0, courses });
      }
      case 'get_rules_status':
        return JSON.stringify(rulesStatus(sid));
      case 'get_procedures_faq': {
        const topic = normalizeText(String(call.input.topic ?? ''));
        const hit = db.settings.faq.find((f: Row) => f.keywords.some((k: string) => topic.includes(k)));
        return JSON.stringify(hit ? { found: true, topic: hit.topic, answer: hit.answer } : { found: false });
      }
      case 'log_mood_checkin': {
        const score = Math.max(1, Math.min(5, Math.round(Number(call.input.score))));
        (db.moodCheckins as Row[]).push({ id: id('mood'), scholarId: sid, score, text: String(call.input.note ?? ''), channel: 'whatsapp', level: 'NINGUNO', createdAt: iso(now) });
        const sig = db.weeklySignals.find((x: Row) => x.scholarId === sid && x.weekStart === weekStart);
        if (sig) sig.mood = score;
        effects.moodLogged = score;
        return JSON.stringify({ ok: true });
      }
      case 'request_human':
        effects.humanRequested = { reason: String(call.input.reason ?? ''), team: String(call.input.team ?? 'COORDINADOR') };
        return JSON.stringify({ ok: true, message: 'El equipo fue notificado.' });
      default:
        throw new Error(`Herramienta desconocida: ${call.name}`);
    }
  };
}

function inboundMessage(sid: string, text: string, now: Date) {
  const c = conversation(sid);
  (db.messages as Row[]).push({
    id: id('msg'),
    conversationId: c.id,
    direction: 'IN',
    initiator: 'SCHOLAR',
    kind: 'FREE',
    templateName: null,
    templateParams: [],
    category: null,
    body: text,
    status: 'RECIBIDO',
    channel: 'simulator',
    createdAt: iso(now),
  });
  c.lastInboundAt = iso(now);
  return c;
}

async function handleInbound(sid: string, text: string) {
  const now = demoNow();
  const c = inboundMessage(sid, text, now);
  const cmd = parseInbound(text);
  if (cmd.type === 'OPT_OUT') {
    Object.assign(c, { optedOutAt: iso(now), optOutConfirmed: false });
    for (const x of db.consents.filter((x: Row) => x.scholarId === sid && x.type === 'WHATSAPP' && !x.revokedAt)) x.revokedAt = iso(now);
    await sendToScholar({ scholarId: sid, intent: { initiator: 'OPT_OUT_CONFIRMATION', kind: 'FREE' }, text: 'Listo, ya no recibirás mensajes de Acompaña por WhatsApp. Si cambias de opinión, escribe ALTA.' });
    return { outcome: 'OPT_OUT' };
  }
  if (cmd.type === 'OPT_IN') {
    const t = db.settings.consentTexts.WHATSAPP;
    (db.consents as Row[]).push({ id: id('consent'), scholarId: sid, type: 'WHATSAPP', textVersion: t.version, textSnapshot: t.text, channel: 'simulator:ALTA', acceptedAt: iso(now), revokedAt: null });
    Object.assign(c, { optedOutAt: null, optOutConfirmed: false });
    await sendToScholar({ scholarId: sid, intent: { initiator: 'REPLY', kind: 'FREE' }, text: '¡Qué bueno tenerte de vuelta! Volverás a recibir recordatorios y check-ins. ¿En qué te ayudo hoy?' });
    return { outcome: 'OPT_IN' };
  }

  const crisis = detectCrisis(text);
  if (crisis.level === 'CRISIS') {
    // No se responde con el asistente: escala de inmediato a una persona y muestra la línea de ayuda.
    (db.moodCheckins as Row[]).push({ id: id('mood'), scholarId: sid, score: null, text, channel: 'simulator', level: 'CRISIS', createdAt: iso(now) });
    recalcScholar(sid, 'CRISIS_CHAT');
    if (c.optedOutAt) return { outcome: 'CRISIS_ESCALADA' };
    const psych = [...db.alerts].reverse().find((a: Row) => a.scholarId === sid && a.profile === 'MALESTAR_EMOCIONAL' && a.direction === 'TEAM' && a.status !== 'CERRADA');
    const name = psych?.assigneeId ? userOf(psych.assigneeId).name : null;
    const who = name ? `${name}, psicóloga de tu universidad,` : 'una persona del equipo de psicología';
    await sendToScholar({
      scholarId: sid,
      intent: { initiator: 'SAFETY', kind: 'FREE' },
      text: `Gracias por contármelo; me importa lo que te pasa y no tienes que pasarlo solo/a. Ya avisé a ${who} para que te contacte hoy mismo. ${db.settings.crisisHelpline.text} ¿Estás en un lugar seguro en este momento?`,
    });
    return { outcome: 'CRISIS_ESCALADA' };
  }
  if (crisis.level === 'MALESTAR') {
    (db.moodCheckins as Row[]).push({ id: id('mood'), scholarId: sid, score: null, text, channel: 'simulator', level: 'MALESTAR', createdAt: iso(now) });
  }
  if (c.optedOutAt) {
    if (crisis.level === 'MALESTAR') recalcScholar(sid, 'MALESTAR_CHAT');
    return { outcome: 'SIN_RESPUESTA_POR_BAJA' };
  }

  const history = db.messages.filter((m: Row) => m.conversationId === c.id && m.status !== 'BLOQUEADO').slice(-12);
  const turns: ChatTurn[] = history.map((m: Row) => ({ role: m.direction === 'IN' ? 'user' : 'assistant', text: m.body }));
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const effects = { humanRequested: null as { reason: string; team: string } | null, moodLogged: null as number | null };
  const reply = await provider.reply({ system: ASSISTANT_SYSTEM_PROMPT, history: turns, tools: ASSISTANT_TOOLS, runTool: toolRunner(sid, effects) });

  if (crisis.level === 'MALESTAR' || effects.moodLogged !== null) recalcScholar(sid, crisis.level === 'MALESTAR' ? 'MALESTAR_CHAT' : 'CHECKIN');
  if (effects.humanRequested && (effects.humanRequested.team !== 'PSICOLOGIA' || crisis.level === 'NINGUNO')) {
    requestAlert(sid, effects.humanRequested.team, effects.humanRequested.reason);
  }
  await sendToScholar({ scholarId: sid, intent: { initiator: 'REPLY', kind: 'FREE' }, text: reply.text });
  return { outcome: 'RESPUESTA' };
}

function requestAlert(sid: string, team: string, reason: string) {
  const { weekStart, now } = currentWeek();
  const s = scholar(sid);
  const owner: Owner =
    team === 'PSICOLOGIA' ? { role: 'TUTOR', specialty: 'PSICOLOGIA' } : team === 'TUTOR_ACADEMICO' ? { role: 'TUTOR', specialty: 'ACADEMICO' } : team === 'MENTOR' ? { role: 'MENTOR' } : { role: 'COORDINADOR' };
  const dedupeKey = `${sid}:SOLICITUD_${team}:${weekStart}:TEAM`;
  if (db.alerts.some((a: Row) => a.dedupeKey === dedupeKey)) return;
  upsertAlert(
    {
      dedupeKey,
      direction: 'TEAM',
      severity: 'AMARILLO',
      profile: team === 'PSICOLOGIA' ? 'MALESTAR_EMOCIONAL' : 'ESTABLE',
      reason: `Solicitud desde el chat: ${reason}`,
      nextStep: 'Contactar al becario para atender su consulta.',
      owner,
      dueAt: addHours(now, db.settings.sla.hoursBySeverity.AMARILLO),
    },
    s,
    now,
    'CHAT',
  );
}

/* ---------- demo: avanzar una semana ---------- */
function latestGoal(sid: string) {
  return db.weeklyGoals.find((g: Row) => g.scholarId === sid) as Row | undefined;
}

async function advanceDemoWeek() {
  const before = currentWeek();
  db.demoClock.weekNumber += 1;
  db.demoClock.offsetDays += 7;
  const { weekStart, now, weekNumber: week } = currentWeek();
  const rng = createRng(1000 + week);
  for (const s of db.scholars as Row[]) {
    const latent = s.synthLatent as LatentStudent | null;
    const last = db.weeklySignals.filter((x: Row) => x.scholarId === s.id).at(-1);
    if (!latent || !last) continue;
    const failed = db.enrollments.filter((e: Row) => e.scholarId === s.id && e.status === 'DESAPROBADO').length;
    const attendedIds = new Set(db.alertActions.map((a: Row) => a.alertId));
    const attended = db.alerts.some((a: Row) => a.scholarId === s.id && a.direction === 'TEAM' && attendedIds.has(a.id));
    let sig: WeeklySignals = { ...sampleWeek(latent, week, rng, failed), studyHoursTarget: latent.studyHoursTarget };
    sig.avgPartial = last.avgPartial === null ? sig.avgPartial : Math.round(clamp(last.avgPartial + rng.normal(attended ? 0.3 : 0, 0.3), 0, 20) * 10) / 10;
    if (s.id === 'sch-ana') sig = { ...sig, attendanceRate: 0.95, activeDays: 6, studyHours: 12, mood: 4, avgPartial: 15.9 };
    if (s.id === 'sch-luis')
      sig = attended ? { ...sig, attendanceRate: 0.88, activeDays: 4, studyHours: 9, mood: 4, avgPartial: 11.6 } : { ...sig, attendanceRate: 0.7, activeDays: 1, studyHours: 4, mood: 2, avgPartial: 10.1 };
    if (s.id === 'sch-rosa')
      sig = attended ? { ...sig, attendanceRate: 0.88, activeDays: 5, studyHours: 10, mood: 3, avgPartial: 13.5 } : { ...sig, attendanceRate: 0.78, activeDays: 3, studyHours: 7, mood: 2, avgPartial: 12.9 };
    db.weeklySignals = db.weeklySignals.filter((x: Row) => !(x.scholarId === s.id && x.weekStart === weekStart));
    (db.weeklySignals as Row[]).push({ id: id('sig'), scholarId: s.id, weekStart, weekNumber: week, ...sig });
    if (sig.mood !== null) (db.moodCheckins as Row[]).push({ id: id('mood'), scholarId: s.id, score: sig.mood, text: null, channel: 'whatsapp', level: 'NINGUNO', createdAt: iso(now) });
    const g = latestGoal(s.id);
    if (g) {
      g.weekStart = weekStart;
      g.courseGoals = (g.courseGoals as Row[])
        .filter((c) => !c.courseId.endsWith('-NIV'))
        .map((c) => ({ ...c, topic: (course(c.courseId).weeklyTopics as Row)[String(week)] ?? null, done: Math.round((sig.studyHours / latent.studyHoursTarget) * c.target * 10) / 10 }));
    }
  }
  await deliverDue();
  const recalc = recalcAll();
  return { from: before.weekStart, to: weekStart, weekNumber: week, recalc };
}

/* ---------- ingreso con DNI ---------- */
const loginAttempts = new Map<string, LoginAttemptState>();

/** Verifica PBKDF2-SHA256 (mismo formato que packages/db/src/services/password.ts) con Web Crypto. */
async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, it, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const b64 = (x: string) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0));
  const expected = b64(hashB64);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(saltB64), iterations: Number(it) }, key, expected.length * 8));
  let diff = bits.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

/* ---------- plan de estudio personalizado (misma función de dominio que la API) ---------- */
const normDow = (x: number) => (x === 0 ? 7 : x);
function todayDow(): number {
  const p = zonedParts(demoNow(), 'America/Lima');
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}
function planBlocks(planId: string): Row[] {
  return (db.studyBlocks as Row[]).filter((b) => b.planId === planId).sort((a, b) => a.dow - b.dow || a.start.localeCompare(b.start));
}
function ensureStudyPlan(sid: string): Row | null {
  db.studyPlans ??= [];
  db.studyBlocks ??= [];
  const { weekStart, weekNumber, now } = currentWeek();
  const existing = (db.studyPlans as Row[]).find((x) => x.scholarId === sid && x.weekStart === weekStart);
  if (existing) return existing;
  const s = scholar(sid);
  if (!s.onboardingDoneAt) return null;
  const enr = db.enrollments.filter((e: Row) => e.scholarId === sid);
  const ob = db.onboardings.find((o: Row) => o.scholarId === sid);
  const prof = latestBy(db.profileSnapshots, sid);
  const sig = db.weeklySignals.find((x: Row) => x.scholarId === sid && x.weekStart === weekStart);
  const rs = ruleSet(s);
  const courses: PlanCourse[] = enr
    .filter((e: Row) => e.status === 'EN_CURSO')
    .map((e: Row) => {
      const c = course(e.courseId);
      return {
        id: c.id,
        name: c.name,
        credits: c.credits,
        schedule: c.schedule,
        avgGrade: e.partialGrades.length ? Math.round((e.partialGrades.reduce((a: number, b: number) => a + b, 0) / e.partialGrades.length) * 10) / 10 : null,
        topic: (c.weeklyTopics as Row)[String(weekNumber)] ?? null,
      };
    });
  const plan = buildStudyPlan({
    courses,
    studyHoursTarget: latestGoal(sid)?.studyHoursTarget ?? 12,
    passingGrade: rs.passingGrade,
    gpaWarningMargin: rs.gpaWarningMargin,
    diagnostic: { math: ob?.mathScore ?? null, reading: ob?.readingScore ?? null },
    failedCourseNames: enr.filter((e: Row) => e.status === 'DESAPROBADO').map((e: Row) => course(e.courseId).name),
    profiles: prof?.profiles ?? [],
  });
  const done = premarkDoneBlocks(plan.blocks, sig?.studyHours ?? 0, todayDow());
  const row: Row = { id: id('plan'), scholarId: sid, weekStart, priorities: plan.priorities, notes: plan.notes, createdAt: iso(now) };
  (db.studyPlans as Row[]).push(row);
  plan.blocks.forEach((b, i) => (db.studyBlocks as Row[]).push({ ...b, id: id('blk'), planId: row.id, doneAt: done[i] ? iso(now) : null }));
  save();
  return row;
}
function markStudyBlock(sid: string, blockId: string, done: boolean) {
  const b = (db.studyBlocks as Row[]).find((x) => x.id === blockId);
  const plan = b && (db.studyPlans as Row[]).find((x) => x.id === b.planId);
  if (!b || !plan || plan.scholarId !== sid) throw new HttpError(404, 'BLOQUE_NO_ENCONTRADO', 'Bloque no encontrado.');
  const { weekStart, now } = currentWeek();
  if (plan.weekStart !== weekStart) throw new HttpError(409, 'SEMANA_CERRADA', 'Ese bloque es de una semana anterior.');
  if (done && !canMarkBlock(b.dow, todayDow())) throw new HttpError(409, 'BLOQUE_FUTURO', 'Podrás marcarlo cuando llegue ese día.');
  if (Boolean(b.doneAt) === done) return b;
  const delta = (done ? 1 : -1) * (b.minutes / 60);
  b.doneAt = done ? iso(now) : null;
  const sig = db.weeklySignals.find((x: Row) => x.scholarId === sid && x.weekStart === weekStart);
  if (sig) sig.studyHours = Math.max(0, Math.round((sig.studyHours + delta) * 100) / 100);
  const g = latestGoal(sid);
  if (g && b.courseId) g.courseGoals = (g.courseGoals as Row[]).map((c) => (c.courseId === b.courseId ? { ...c, done: Math.max(0, Math.round((c.done + delta) * 10) / 10) } : c));
  return b;
}

/* ---------- rutas ---------- */
const latestBy = (rows: Row[], sid: string) => {
  let best: Row | undefined;
  for (const r of rows) if (r.scholarId === sid && (!best || r.createdAt >= best.createdAt)) best = r;
  return best;
};

export async function handle(method: string, path: string, body: any, user: AuthUser | null): Promise<any> {
  const url = new URL(path, 'http://demo.local');
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams.entries());
  const m = (re: RegExp) => p.match(re);
  await deliverDue();
  const result = await route(method, p, q, m, body ?? {}, user);
  if (method !== 'GET') save();
  return result;
}

async function route(method: string, p: string, q: Record<string, string>, m: (re: RegExp) => RegExpMatchArray | null, body: any, user: AuthUser | null): Promise<any> {
  /* auth */
  if (method === 'GET' && p === '/auth/demo-users') {
    return (db.users as Row[])
      .filter((u) => u.isDemo && u.dni)
      .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name))
      .map((u) => ({
        dni: u.dni,
        name: u.name,
        role: u.role,
        specialty: u.specialty,
        university: u.universityId ? university(u.universityId).name : 'Pronabec (todas)',
        persona: db.scholars.find((s: Row) => s.userId === u.id)?.persona ?? null,
      }));
  }
  if (method === 'POST' && p === '/auth/login') {
    const dni = normalizeDni(String(body.dni ?? ''));
    if (!isValidDni(dni)) throw new HttpError(400, 'DNI_INVALIDO', 'El DNI debe tener 8 dígitos.');
    const nowMs = Date.now();
    if (isLocked(loginAttempts.get(dni), nowMs)) {
      throw new HttpError(429, 'INGRESO_BLOQUEADO', 'Demasiados intentos. Vuelve a intentarlo en 15 minutos o pide ayuda a tu coordinador.');
    }
    const u = db.users.find((x: Row) => x.dni === dni);
    const ok = Boolean(u) && (await verifyPassword(String(body.password ?? ''), u!.passwordHash));
    loginAttempts.set(dni, registerAttempt(loginAttempts.get(dni), ok, nowMs));
    if (!ok || !u) throw new HttpError(401, 'CREDENCIALES_INVALIDAS', 'DNI o contraseña incorrectos.');
    const s = db.scholars.find((x: Row) => x.userId === u.id);
    const payload: AuthUser = { sub: u.id, name: u.name, role: u.role, specialty: u.specialty, universityId: u.universityId, scholarId: s?.id ?? null };
    return { token: 'demo-navegador', user: payload };
  }

  /* becario */
  if (p.startsWith('/scholar/')) {
    const u = requireRole(user, 'BECARIO');
    const sid = u.scholarId!;
    const s = scholar(sid);
    const { weekStart, weekNumber, now } = currentWeek();
    if (method === 'GET' && p === '/scholar/home') {
      const alert = [...db.alerts].reverse().find((a: Row) => a.scholarId === sid && a.direction === 'SCHOLAR' && a.status !== 'CERRADA');
      const cl = db.scholarChecklists.filter((c: Row) => c.scholarId === sid);
      const mentor = db.mentorAssignments.find((x: Row) => x.scholarId === sid && x.active);
      return {
        name: userOf(s.userId).name,
        firstName: userOf(s.userId).name.split(' ')[0],
        university: university(s.universityId).name,
        career: career(s.careerId).name,
        origin: region(s.originRegionId).name,
        cohort: { code: ruleSet(s).code, name: ruleSet(s).name },
        week: { weekStart, weekNumber },
        onboardingDone: Boolean(s.onboardingDoneAt),
        consents: db.consents.filter((c: Row) => c.scholarId === sid && !c.revokedAt).map((c: Row) => ({ type: c.type, acceptedAt: c.acceptedAt, textVersion: c.textVersion })),
        nextStep: alert ? { text: alert.nextStep, profile: alert.profile } : null,
        signals: db.weeklySignals.find((x: Row) => x.scholarId === sid && x.weekStart === weekStart) ?? null,
        goal: latestGoal(sid) ?? null,
        checklist: { total: cl.length, done: cl.filter((c: Row) => c.doneAt).length },
        mentor: mentor ? { name: userOf(mentor.mentorId).name, reason: mentor.reason } : null,
        rules: s.onboardingDoneAt ? rulesStatus(sid) : null,
      };
    }
    if (method === 'GET' && p === '/scholar/onboarding') {
      return { diagnostic: publicDiagnostic(), consentTexts: db.settings.consentTexts, regions: [...db.regions].sort((a: Row, b: Row) => a.name.localeCompare(b.name)) };
    }
    if (method === 'POST' && p === '/scholar/onboarding') return onboarding(sid, body, now, weekStart);
    if (method === 'GET' && p === '/scholar/checklist') {
      return db.scholarChecklists
        .filter((c: Row) => c.scholarId === sid)
        .sort((a: Row, b: Row) => (a.dueDate < b.dueDate ? -1 : 1))
        .map((r: Row) => {
          const it = db.checklistItems.find((i: Row) => i.id === r.itemId)!;
          return { itemId: r.itemId, category: it.category, title: it.title, detail: it.detail, dueDate: r.dueDate, doneAt: r.doneAt, overdue: !r.doneAt && new Date(r.dueDate) < now };
        });
    }
    const ck = m(/^\/scholar\/checklist\/([^/]+)$/);
    if (method === 'POST' && ck) {
      const r = db.scholarChecklists.find((c: Row) => c.scholarId === sid && c.itemId === ck[1]);
      if (r) r.doneAt = body.done ? iso(now) : null;
      return { ok: true };
    }
    if (method === 'GET' && p === '/scholar/plan') {
      const plan = ensureStudyPlan(sid);
      const enr = db.enrollments.filter((e: Row) => e.scholarId === sid);
      return {
        week: { weekStart, weekNumber },
        todayDow: todayDow(),
        goal: latestGoal(sid) ?? null,
        signal: db.weeklySignals.find((x: Row) => x.scholarId === sid && x.weekStart === weekStart) ?? null,
        studyPlan: plan && { priorities: plan.priorities, notes: plan.notes, blocks: planBlocks(plan.id) },
        classes: enr
          .filter((e: Row) => e.status === 'EN_CURSO')
          .flatMap((e: Row) => (course(e.courseId).schedule as Row[]).map((x) => ({ ...x, course: course(e.courseId).name }))),
        courses: enr
          .map((e: Row) => {
            const c = course(e.courseId);
            return { name: c.name, credits: c.credits, status: e.status, partialGrades: e.partialGrades, finalGrade: e.finalGrade, topic: (c.weeklyTopics as Row)[String(weekNumber)] ?? null };
          })
          .sort((a: Row, b: Row) => a.name.localeCompare(b.name)),
        rules: rulesStatus(sid),
      };
    }
    const blk = m(/^\/scholar\/plan\/blocks\/([^/]+)$/);
    if (method === 'POST' && blk) return markStudyBlock(sid, blk[1], Boolean(body.done));
    if (method === 'POST' && p === '/scholar/life-event') {
      s.lifeEventReported = true;
      (db.moodCheckins as Row[]).push({ id: id('mood'), scholarId: sid, score: null, text: `Evento de vida: ${String(body.note ?? '').slice(0, 500)}`, channel: 'web', level: 'NINGUNO', createdAt: iso(now) });
      const r = recalcScholar(sid, 'EVENTO_VIDA');
      return { ok: true, profiles: r.profiles };
    }
  }

  /* chat */
  const chat = m(/^\/chat\/([^/]+)(\/inbound)?$/);
  if (chat) {
    const u = requireRole(user);
    const sid = chat[1];
    if (method === 'POST' && chat[2]) {
      if (u.role !== 'BECARIO' || u.scholarId !== sid) throw new HttpError(403, 'SIN_PERMISO', 'Solo el becario puede escribir desde su teléfono.');
      const text = String(body.text ?? '').trim();
      if (!text) throw new HttpError(400, 'DATOS_INVALIDOS', 'Escribe un mensaje.');
      return handleInbound(sid, text.slice(0, 1000));
    }
    assertCanSee(u, sid);
    const c = conversation(sid);
    const st = conversationState(sid);
    const isScholar = u.role === 'BECARIO';
    return {
      provider: 'mock',
      state: {
        optIn: st.optIn,
        optedOutAt: st.optedOutAt,
        windowOpen: isWindowOpen(st.lastInboundAt, demoNow()),
        windowClosesAt: st.lastInboundAt ? new Date(st.lastInboundAt.getTime() + 24 * 3600_000) : null,
        platformSentToday: st.platformSentAt.length,
      },
      messages: db.messages
        .filter((x: Row) => x.conversationId === c.id && (!isScholar || x.status !== 'BLOQUEADO'))
        .map((x: Row) => ({ ...x, policyDecision: isScholar ? undefined : x.policyDecision, errorCode: isScholar ? undefined : x.errorCode })),
    };
  }

  /* panel */
  if (p.startsWith('/panel/')) {
    const u = requireRole(user, 'COORDINADOR', 'TUTOR', 'MENTOR');
    const { now, weekStart, weekNumber } = currentWeek();
    const visible = (db.scholars as Row[]).filter((s) => inScope(u, s));
    const visibleIds = new Set(visible.map((s) => s.id));
    const alertView = (a: Row) => ({ ...a, sla: slaStatus({ dueAt: d(a.dueAt), firstActionAt: d(a.firstActionAt) }, now) });

    if (method === 'GET' && p === '/panel/overview') {
      const byColor: Record<string, number> = { VERDE: 0, AMARILLO: 0, ROJO: 0, SIN_DATOS: 0 };
      const byProfile: Record<string, number> = {};
      for (const s of visible) {
        byColor[latestBy(db.riskSnapshots, s.id)?.color ?? 'SIN_DATOS']++;
        for (const pr of latestBy(db.profileSnapshots, s.id)?.profiles ?? []) byProfile[pr] = (byProfile[pr] ?? 0) + 1;
      }
      const alerts = db.alerts.filter((a: Row) => a.direction === 'TEAM' && visibleIds.has(a.scholarId));
      const open = alerts.filter((a: Row) => a.status !== 'CERRADA');
      const reds = alerts.filter((a: Row) => a.severity === 'ROJO');
      const sla = { CUMPLIDA: 0, INCUMPLIDA: 0, EN_PLAZO: 0, VENCIDA: 0, SIN_SLA: 0 };
      for (const a of reds) sla[slaStatus({ dueAt: d(a.dueAt), firstActionAt: d(a.firstActionAt) }, now)]++;
      const decided = sla.CUMPLIDA + sla.INCUMPLIDA + sla.VENCIDA;
      const hrs = reds.filter((a: Row) => a.firstActionAt).map((a: Row) => (new Date(a.firstActionAt).getTime() - new Date(a.createdAt).getTime()) / 3600_000);
      const model = riskModel as LogisticModel;
      return {
        week: { weekStart, weekNumber, now },
        scholars: visible.length,
        byColor,
        byProfile,
        alerts: { open: open.length, openRed: open.filter((a: Row) => a.severity === 'ROJO').length, openYellow: open.filter((a: Row) => a.severity === 'AMARILLO').length },
        sla48: { ...sla, complianceRate: decided ? sla.CUMPLIDA / decided : null, avgHoursToFirstAction: hrs.length ? hrs.reduce((a: number, b: number) => a + b, 0) / hrs.length : null },
        messaging: [],
        model: { version: model.version, metrics: model.metrics, note: 'Entrenado con datos sintéticos: mide recuperación de patrones plantados, no desempeño real.' },
      };
    }
    if (method === 'GET' && p === '/panel/scholars') {
      const rank: Record<string, number> = { ROJO: 0, AMARILLO: 1, VERDE: 2, SIN_DATOS: 3 };
      return visible
        .filter((s) => !q.q || userOf(s.userId).name.toLowerCase().includes(q.q.toLowerCase()))
        .map((s) => {
          const r = latestBy(db.riskSnapshots, s.id);
          const pr = latestBy(db.profileSnapshots, s.id);
          return {
            id: s.id,
            name: userOf(s.userId).name,
            persona: s.persona !== 'sintético' ? s.persona : null,
            university: university(s.universityId).name,
            career: career(s.careerId).name,
            cohort: ruleSet(s).code,
            color: r?.color ?? 'SIN_DATOS',
            probability: r?.probability ?? null,
            topReason: (r?.reasons as Row[] | undefined)?.find((x) => x.direction === 'SUBE')?.text ?? null,
            profiles: pr?.profiles ?? [],
            openAlerts: db.alerts.filter((a: Row) => a.scholarId === s.id && a.direction === 'TEAM' && a.status !== 'CERRADA').length,
          };
        })
        .filter((s) => (!q.color || s.color === q.color) && (!q.profile || s.profiles.includes(q.profile)))
        .sort((a, b) => rank[a.color] - rank[b.color] || (b.probability ?? 0) - (a.probability ?? 0));
    }
    const det = m(/^\/panel\/scholars\/([^/]+)$/);
    if (method === 'GET' && det) {
      const sid = det[1];
      assertCanSee(u, sid);
      const s = scholar(sid);
      const rs = ruleSet(s);
      const hideEmotional = u.role === 'MENTOR';
      const mentor = db.mentorAssignments.find((x: Row) => x.scholarId === sid && x.active);
      const cl = db.scholarChecklists.filter((c: Row) => c.scholarId === sid);
      return {
        id: s.id,
        name: userOf(s.userId).name,
        persona: s.persona !== 'sintético' ? s.persona : null,
        university: university(s.universityId).name,
        career: career(s.careerId).name,
        origin: region(s.originRegionId).name,
        livesAlone: s.livesAlone,
        cohort: { code: rs.code, name: rs.name, legalRef: rs.legalRef },
        onboarding: db.onboardings.find((o: Row) => o.scholarId === sid) ?? null,
        consents: db.consents.filter((c: Row) => c.scholarId === sid).sort((a: Row, b: Row) => (a.acceptedAt < b.acceptedAt ? 1 : -1)),
        mentor: mentor ? { name: userOf(mentor.mentorId).name, reason: mentor.reason } : null,
        checklist: {
          total: cl.length,
          overdue: cl.filter((c: Row) => !c.doneAt && new Date(c.dueDate) < now).map((c: Row) => db.checklistItems.find((i: Row) => i.id === c.itemId)!.title),
        },
        signals: db.weeklySignals.filter((x: Row) => x.scholarId === sid).map((x: Row) => ({ ...x, mood: hideEmotional ? null : x.mood })),
        risks: db.riskSnapshots.filter((r: Row) => r.scholarId === sid),
        profiles: db.profileSnapshots.filter((r: Row) => r.scholarId === sid),
        rules: rulesStatus(sid),
        studyPlan: (() => {
          const plan = [...(db.studyPlans as Row[])].reverse().find((x) => x.scholarId === sid);
          if (!plan) return null;
          const bl = planBlocks(plan.id);
          return {
            weekStart: plan.weekStart,
            priorities: plan.priorities,
            blocksTotal: bl.length,
            blocksDone: bl.filter((b) => b.doneAt).length,
            minutesPlanned: bl.reduce((a, b) => a + b.minutes, 0),
            minutesDone: bl.filter((b) => b.doneAt).reduce((a, b) => a + b.minutes, 0),
          };
        })(),
        alerts: [...db.alerts]
          .reverse()
          .filter((a: Row) => a.scholarId === sid && (!hideEmotional || a.profile !== 'MALESTAR_EMOCIONAL'))
          .map((a: Row) => ({
            ...alertView(a),
            assignee: a.assigneeId ? { name: userOf(a.assigneeId).name } : null,
            actions: db.alertActions.filter((x: Row) => x.alertId === a.id).map((x: Row) => ({ ...x, actor: { name: userOf(x.actorId).name } })),
          })),
      };
    }
    if (method === 'GET' && p === '/panel/alerts') {
      const sev: Record<string, number> = { ROJO: 0, AMARILLO: 1 };
      return db.alerts
        .filter(
          (a: Row) =>
            a.direction === 'TEAM' &&
            visibleIds.has(a.scholarId) &&
            (q.status === 'todas' || a.status !== 'CERRADA') &&
            (u.role === 'COORDINADOR' || a.assigneeId === u.sub),
        )
        .sort((a: Row, b: Row) => sev[a.severity] - sev[b.severity] || String(a.dueAt).localeCompare(String(b.dueAt)))
        .map((a: Row) => {
          const s = scholar(a.scholarId);
          return {
            ...alertView(a),
            scholarName: userOf(s.userId).name,
            university: university(s.universityId).name,
            assignee: a.assigneeId ? userOf(a.assigneeId).name : null,
            actions: db.alertActions.filter((x: Row) => x.alertId === a.id).length,
          };
        });
    }
    const act = m(/^\/panel\/alerts\/([^/]+)\/actions$/);
    if (method === 'POST' && act) {
      const a = db.alerts.find((x: Row) => x.id === act[1]);
      if (!a) throw new HttpError(404, 'NO_ENCONTRADO', 'Alerta no encontrada');
      assertCanSee(u, a.scholarId);
      if (u.role !== 'COORDINADOR' && a.assigneeId !== u.sub) throw new HttpError(403, 'NO_ES_RESPONSABLE', 'Solo el responsable asignado o un coordinador puede registrar acciones.');
      const note = String(body.note ?? '').trim();
      if (note.length < 3) throw new HttpError(400, 'DATOS_INVALIDOS', 'Describe la acción (mínimo 3 caracteres).');
      addAlertAction(a.id, u.sub, body.type, note.slice(0, 1000));
      return a;
    }
    if (method === 'GET' && p === '/panel/templates') return Object.values(TEMPLATE_CATALOG);
    const msg = m(/^\/panel\/scholars\/([^/]+)\/message$/);
    if (method === 'POST' && msg) {
      assertCanSee(u, msg[1]);
      const r = await sendToScholar({
        scholarId: msg[1],
        intent: body.kind === 'TEMPLATE' ? { initiator: 'PLATFORM', kind: 'TEMPLATE', templateName: body.templateName } : { initiator: 'HUMAN', kind: 'FREE' },
        text: body.text,
        templateParams: body.params,
      });
      return { id: r.id, status: r.status, policyDecision: r.policyDecision, scheduledFor: r.scheduledFor, errorCode: r.errorCode, body: r.body };
    }
    const rc = m(/^\/panel\/scholars\/([^/]+)\/recalculate$/);
    if (method === 'POST' && rc) {
      assertCanSee(u, rc[1]);
      return recalcScholar(rc[1], 'MANUAL');
    }
    if (method === 'POST' && p === '/panel/demo/advance-week') {
      requireRole(u, 'COORDINADOR');
      return advanceDemoWeek();
    }
  }
  throw new HttpError(404, 'RUTA_NO_ENCONTRADA', `No existe ${method} ${p}`);
}

/* ---------- onboarding ---------- */
function onboarding(sid: string, body: any, now: Date, weekStart: string) {
  if (!body.consents?.datos) {
    throw new HttpError(
      400,
      'CONSENTIMIENTO_DATOS_REQUERIDO',
      'Sin tu autorización de datos (Ley 29733) no podemos acompañarte con la plataforma. Puedes seguir contactando a tu coordinador por los canales habituales.',
    );
  }
  const t = db.settings.consentTexts;
  if (body.consentVersions?.datos !== t.DATOS_LEY_29733.version || body.consentVersions?.whatsapp !== t.WHATSAPP.version) {
    throw new HttpError(409, 'TEXTO_CONSENTIMIENTO_CAMBIO', 'El texto del consentimiento cambió; vuelve a leerlo.');
  }
  const s = scholar(sid);
  const { mathScore, readingScore } = scoreDiagnostic(body.mathAnswers, body.readingAnswers);
  const away = body.originRegionId !== university(s.universityId).regionId;
  Object.assign(s, { originRegionId: body.originRegionId, livesAlone: Boolean(body.livesAlone), onboardingDoneAt: iso(now) });
  db.onboardings = db.onboardings.filter((o: Row) => o.scholarId !== sid);
  (db.onboardings as Row[]).push({ id: id('ob'), scholarId: sid, careerFit: body.careerFit, mood: body.mood, mathScore, readingScore, studiesAwayFromHome: away, createdAt: iso(now) });
  (db.consents as Row[]).push({ id: id('consent'), scholarId: sid, type: 'DATOS_LEY_29733', textVersion: t.DATOS_LEY_29733.version, textSnapshot: t.DATOS_LEY_29733.text, channel: 'web-onboarding', acceptedAt: iso(now), revokedAt: null });
  if (body.consents.whatsapp) {
    (db.consents as Row[]).push({ id: id('consent'), scholarId: sid, type: 'WHATSAPP', textVersion: t.WHATSAPP.version, textSnapshot: t.WHATSAPP.text, channel: 'web-onboarding', acceptedAt: iso(now), revokedAt: null });
  }
  (db.moodCheckins as Row[]).push({ id: id('mood'), scholarId: sid, score: body.mood, text: null, channel: 'onboarding', level: 'NINGUNO', createdAt: iso(now) });
  for (const it of db.checklistItems as Row[]) {
    if (!db.scholarChecklists.some((c: Row) => c.scholarId === sid && c.itemId === it.id)) {
      (db.scholarChecklists as Row[]).push({ id: id('cl'), scholarId: sid, itemId: it.id, dueDate: iso(new Date(now.getTime() + it.dueDays * DAY)), doneAt: null });
    }
  }
  const courses = db.courses.filter((c: Row) => c.careerId === s.careerId && !c.id.endsWith('-NIV'));
  for (const c of courses) {
    if (!db.enrollments.some((e: Row) => e.scholarId === sid && e.courseId === c.id)) {
      (db.enrollments as Row[]).push({ id: id('enr'), scholarId: sid, courseId: c.id, term: '2026-II', attempt: 1, partialGrades: [], finalGrade: null, status: 'EN_CURSO' });
    }
  }
  if (!latestGoal(sid)) {
    (db.weeklyGoals as Row[]).push({
      id: id('goal'),
      scholarId: sid,
      weekStart,
      attendanceTarget: 0.9,
      studyHoursTarget: mathScore < 60 || readingScore < 60 ? 14 : 12,
      courseGoals: courses.map((c: Row) => ({
        courseId: c.id,
        name: c.name,
        topic: null,
        target: Math.max(1, Math.round((12 * c.credits) / 20)),
        done: 0,
        reinforcement: (c.name.includes('Matemática') && mathScore < 60) || (c.name.includes('Comunicación') && readingScore < 60),
      })),
    });
  }
  conversation(sid);
  return { ok: true, mathScore, readingScore, reinforcement: { math: mathScore < 60, reading: readingScore < 60 } };
}
