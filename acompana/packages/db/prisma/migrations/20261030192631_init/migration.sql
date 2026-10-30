-- CreateEnum
CREATE TYPE "Role" AS ENUM ('BECARIO', 'MENTOR', 'TUTOR', 'COORDINADOR');

-- CreateEnum
CREATE TYPE "Specialty" AS ENUM ('ACADEMICO', 'PSICOLOGIA');

-- CreateEnum
CREATE TYPE "Color" AS ENUM ('VERDE', 'AMARILLO', 'ROJO');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('DATOS_LEY_29733', 'WHATSAPP', 'FAMILIA');

-- CreateEnum
CREATE TYPE "AlertDirection" AS ENUM ('SCHOLAR', 'TEAM');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ABIERTA', 'EN_ATENCION', 'CERRADA');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CONTACTO', 'DERIVACION', 'SESION', 'NOTA', 'CIERRE');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECIBIDO', 'PROGRAMADO', 'ENVIADO', 'ENTREGADO', 'LEIDO', 'FALLIDO', 'BLOQUEADO');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('EN_CURSO', 'APROBADO', 'DESAPROBADO');

-- CreateTable
CREATE TABLE "University" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,

    CONSTRAINT "University_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Career" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "universityId" TEXT NOT NULL,

    CONSTRAINT "Career_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleSet" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalRef" TEXT NOT NULL,
    "passingGrade" DOUBLE PRECISION NOT NULL,
    "gpaWarningMargin" DOUBLE PRECISION NOT NULL,
    "minCreditsPerTerm" INTEGER NOT NULL,
    "requireTopThird" BOOLEAN NOT NULL,
    "failRuleApplies" BOOLEAN NOT NULL,
    "maxFailedCourses" INTEGER NOT NULL,
    "awardedFrom" TIMESTAMP(3),
    "awardedUntil" TIMESTAMP(3),

    CONSTRAINT "RuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "specialty" "Specialty",
    "universityId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "careerId" TEXT,
    "regionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scholar" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "universityId" TEXT NOT NULL,
    "careerId" TEXT NOT NULL,
    "originRegionId" TEXT NOT NULL,
    "livesAlone" BOOLEAN NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "enrolledCredits" INTEGER NOT NULL,
    "cohortPercentile" DOUBLE PRECISION,
    "onboardingDoneAt" TIMESTAMP(3),
    "lifeEventReported" BOOLEAN NOT NULL DEFAULT false,
    "persona" TEXT,
    "synthLatent" JSONB,

    CONSTRAINT "Scholar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "type" "ConsentType" NOT NULL,
    "textVersion" TEXT NOT NULL,
    "textSnapshot" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingAnswer" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "careerFit" INTEGER NOT NULL,
    "mood" INTEGER NOT NULL,
    "mathScore" INTEGER NOT NULL,
    "readingScore" INTEGER NOT NULL,
    "studiesAwayFromHome" BOOLEAN NOT NULL,
    "extras" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "dueDays" INTEGER NOT NULL,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScholarChecklist" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "ScholarChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "careerId" TEXT NOT NULL,
    "schedule" JSONB NOT NULL,
    "weeklyTopics" JSONB NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "partialGrades" DOUBLE PRECISION[],
    "finalGrade" DOUBLE PRECISION,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'EN_CURSO',

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyGoal" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "attendanceTarget" DOUBLE PRECISION NOT NULL,
    "studyHoursTarget" INTEGER NOT NULL,
    "courseGoals" JSONB NOT NULL,

    CONSTRAINT "WeeklyGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklySignal" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "attendanceRate" DOUBLE PRECISION NOT NULL,
    "activeDays" INTEGER NOT NULL,
    "studyHours" DOUBLE PRECISION NOT NULL,
    "studyHoursTarget" INTEGER NOT NULL,
    "avgPartial" DOUBLE PRECISION,
    "failedAttempts" INTEGER NOT NULL,
    "mood" INTEGER,

    CONSTRAINT "WeeklySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodCheckin" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "score" INTEGER,
    "text" TEXT,
    "channel" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'NINGUNO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoodCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskSnapshot" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "color" "Color" NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "reasons" JSONB NOT NULL,
    "rulesFired" TEXT[],
    "modelVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileSnapshot" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "profiles" TEXT[],
    "primary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "direction" "AlertDirection" NOT NULL,
    "severity" "Color" NOT NULL,
    "profile" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "nextStep" TEXT NOT NULL,
    "assigneeId" TEXT,
    "status" "AlertStatus" NOT NULL DEFAULT 'ABIERTA',
    "source" TEXT NOT NULL DEFAULT 'RECALCULO_SEMANAL',
    "dueAt" TIMESTAMP(3),
    "firstActionAt" TIMESTAMP(3),
    "slaMet" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertAction" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "note" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorAssignment" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MentorAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorSession" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "topic" TEXT NOT NULL,
    "note" TEXT NOT NULL,

    CONSTRAINT "MentorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyContact" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "authorizedConsentId" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "FamilyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "lastInboundAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "optOutConfirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "initiator" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "templateName" TEXT,
    "category" TEXT,
    "body" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "channel" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "policyDecision" TEXT,
    "errorCode" TEXT,
    "errorClass" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "raw" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppConfig" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoClock" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "weekNumber" INTEGER NOT NULL,
    "offsetDays" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DemoClock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RuleSet_code_key" ON "RuleSet"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Scholar_userId_key" ON "Scholar"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Scholar_phoneE164_key" ON "Scholar"("phoneE164");

-- CreateIndex
CREATE INDEX "Consent_scholarId_type_idx" ON "Consent"("scholarId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingAnswer_scholarId_key" ON "OnboardingAnswer"("scholarId");

-- CreateIndex
CREATE UNIQUE INDEX "ScholarChecklist_scholarId_itemId_key" ON "ScholarChecklist"("scholarId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_scholarId_courseId_term_attempt_key" ON "Enrollment"("scholarId", "courseId", "term", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyGoal_scholarId_weekStart_key" ON "WeeklyGoal"("scholarId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklySignal_scholarId_weekStart_key" ON "WeeklySignal"("scholarId", "weekStart");

-- CreateIndex
CREATE INDEX "MoodCheckin_scholarId_createdAt_idx" ON "MoodCheckin"("scholarId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskSnapshot_scholarId_createdAt_idx" ON "RiskSnapshot"("scholarId", "createdAt");

-- CreateIndex
CREATE INDEX "ProfileSnapshot_scholarId_createdAt_idx" ON "ProfileSnapshot"("scholarId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_dedupeKey_key" ON "Alert"("dedupeKey");

-- CreateIndex
CREATE INDEX "Alert_status_severity_idx" ON "Alert"("status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "MentorAssignment_mentorId_scholarId_key" ON "MentorAssignment"("mentorId", "scholarId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_scholarId_key" ON "Conversation"("scholarId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_providerMessageId_key" ON "Message"("providerMessageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "University" ADD CONSTRAINT "University_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Career" ADD CONSTRAINT "Career_universityId_fkey" FOREIGN KEY ("universityId") REFERENCES "University"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_universityId_fkey" FOREIGN KEY ("universityId") REFERENCES "University"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scholar" ADD CONSTRAINT "Scholar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scholar" ADD CONSTRAINT "Scholar_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scholar" ADD CONSTRAINT "Scholar_universityId_fkey" FOREIGN KEY ("universityId") REFERENCES "University"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scholar" ADD CONSTRAINT "Scholar_careerId_fkey" FOREIGN KEY ("careerId") REFERENCES "Career"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scholar" ADD CONSTRAINT "Scholar_originRegionId_fkey" FOREIGN KEY ("originRegionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingAnswer" ADD CONSTRAINT "OnboardingAnswer_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarChecklist" ADD CONSTRAINT "ScholarChecklist_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarChecklist" ADD CONSTRAINT "ScholarChecklist_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_careerId_fkey" FOREIGN KEY ("careerId") REFERENCES "Career"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyGoal" ADD CONSTRAINT "WeeklyGoal_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySignal" ADD CONSTRAINT "WeeklySignal_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodCheckin" ADD CONSTRAINT "MoodCheckin_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskSnapshot" ADD CONSTRAINT "RiskSnapshot_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileSnapshot" ADD CONSTRAINT "ProfileSnapshot_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertAction" ADD CONSTRAINT "AlertAction_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertAction" ADD CONSTRAINT "AlertAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorAssignment" ADD CONSTRAINT "MentorAssignment_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorAssignment" ADD CONSTRAINT "MentorAssignment_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorSession" ADD CONSTRAINT "MentorSession_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyContact" ADD CONSTRAINT "FamilyContact_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
