-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dateTime" DATETIME,
    "lastIndexed" DATETIME NOT NULL,
    "instagramSuggested" DATETIME,
    "vectorEmbeddingJson" TEXT NOT NULL,
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
    "tagsJson" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Photo_lastIndexed_idx" ON "Photo"("lastIndexed");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_path_source_key" ON "Photo"("path", "source");
