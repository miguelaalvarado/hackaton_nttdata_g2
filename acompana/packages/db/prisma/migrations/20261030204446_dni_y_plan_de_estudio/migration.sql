-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dni" TEXT,
ADD COLUMN     "passwordHash" TEXT;

-- CreateTable
CREATE TABLE "StudyPlan" (
    "id" TEXT NOT NULL,
    "scholarId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "priorities" JSONB NOT NULL,
    "notes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyBlock" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "dow" INTEGER NOT NULL,
    "start" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "topic" TEXT,
    "reason" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "StudyBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudyPlan_scholarId_weekStart_key" ON "StudyPlan"("scholarId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "User_dni_key" ON "User"("dni");

-- AddForeignKey
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_scholarId_fkey" FOREIGN KEY ("scholarId") REFERENCES "Scholar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyBlock" ADD CONSTRAINT "StudyBlock_planId_fkey" FOREIGN KEY ("planId") REFERENCES "StudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

