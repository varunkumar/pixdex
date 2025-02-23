/*
  Warnings:

  - You are about to drop the column `vectorEmbeddingJson` on the `Photo` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Photo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dateTime" DATETIME,
    "lastIndexed" DATETIME NOT NULL,
    "instagramSuggested" DATETIME,
    "vectorEmbedding" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "fileSize" INTEGER,
    "colorSpace" TEXT,
    "hasAlpha" BOOLEAN,
    "channels" INTEGER,
    "latitude" REAL,
    "longitude" REAL,
    "locationPlace" TEXT,
    "subjectsJson" TEXT NOT NULL,
    "environment" TEXT,
    "description" TEXT NOT NULL,
    "colorsJson" TEXT NOT NULL,
    "patternsJson" TEXT NOT NULL,
    "album" TEXT,
    "season" TEXT,
    "tagsJson" TEXT NOT NULL
);
INSERT INTO "new_Photo" ("album", "channels", "colorSpace", "colorsJson", "dateTime", "description", "environment", "fileSize", "filename", "format", "hasAlpha", "height", "id", "instagramSuggested", "lastIndexed", "latitude", "locationPlace", "longitude", "path", "patternsJson", "season", "source", "subjectsJson", "tagsJson", "width") SELECT "album", "channels", "colorSpace", "colorsJson", "dateTime", "description", "environment", "fileSize", "filename", "format", "hasAlpha", "height", "id", "instagramSuggested", "lastIndexed", "latitude", "locationPlace", "longitude", "path", "patternsJson", "season", "source", "subjectsJson", "tagsJson", "width" FROM "Photo";
DROP TABLE "Photo";
ALTER TABLE "new_Photo" RENAME TO "Photo";
CREATE UNIQUE INDEX "Photo_path_source_key" ON "Photo"("path", "source");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
