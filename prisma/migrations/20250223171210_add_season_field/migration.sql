-- DropIndex
DROP INDEX "Photo_lastIndexed_idx";

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN "season" TEXT;
