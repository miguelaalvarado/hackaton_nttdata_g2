/**
 * Exporta el estado sembrado (datos sintéticos) a JSON para la versión navegador de la demo (apps/web/browser-demo).
 * Uso: npm run db:seed && npm run export:snapshot -w @acompana/db
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../index';
import { DEFAULT_SETTINGS } from '../services/config';

const out = fileURLToPath(new URL('../../../../apps/web/browser-demo/snapshot.json', import.meta.url));

// Solo la meta de la semana más reciente por becario: la UI y "avanzar semana" no usan las anteriores.
const goals = await prisma.weeklyGoal.findMany({ orderBy: { weekStart: 'desc' }, distinct: ['scholarId'] });

const snapshot = {
  snapshotAt: new Date().toISOString(),
  demoClock: await prisma.demoClock.findUniqueOrThrow({ where: { id: 1 } }),
  settings: DEFAULT_SETTINGS,
  regions: await prisma.region.findMany(),
  universities: await prisma.university.findMany(),
  careers: await prisma.career.findMany(),
  ruleSets: await prisma.ruleSet.findMany(),
  users: await prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
  scholars: await prisma.scholar.findMany(),
  consents: await prisma.consent.findMany(),
  onboardings: await prisma.onboardingAnswer.findMany(),
  checklistItems: await prisma.checklistItem.findMany(),
  scholarChecklists: await prisma.scholarChecklist.findMany(),
  courses: await prisma.course.findMany(),
  enrollments: await prisma.enrollment.findMany(),
  weeklyGoals: goals,
  weeklySignals: await prisma.weeklySignal.findMany({ orderBy: { weekStart: 'asc' } }),
  moodCheckins: await prisma.moodCheckin.findMany({ orderBy: { createdAt: 'asc' } }),
  riskSnapshots: await prisma.riskSnapshot.findMany({ orderBy: { createdAt: 'asc' } }),
  profileSnapshots: await prisma.profileSnapshot.findMany({ orderBy: { createdAt: 'asc' } }),
  alerts: await prisma.alert.findMany({ orderBy: { createdAt: 'asc' } }),
  alertActions: await prisma.alertAction.findMany(),
  mentorAssignments: await prisma.mentorAssignment.findMany(),
  conversations: await prisma.conversation.findMany(),
  messages: await prisma.message.findMany({ orderBy: { createdAt: 'asc' } }),
};
// Sin el estado latente del generador (solo lo usa "avanzar semana" de las personas sintéticas): se conserva.
writeFileSync(out, JSON.stringify(snapshot));
console.log(`Snapshot: ${out} (${Math.round(JSON.stringify(snapshot).length / 1024)} KB)`);
await prisma.$disconnect();
