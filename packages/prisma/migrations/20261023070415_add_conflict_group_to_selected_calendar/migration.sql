-- AlterTable
ALTER TABLE "public"."SelectedCalendar" ADD COLUMN     "conflictGroupId" TEXT;

-- CreateIndex
CREATE INDEX "SelectedCalendar_conflictGroupId_idx" ON "public"."SelectedCalendar"("conflictGroupId");
