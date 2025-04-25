import { PrismaClient } from '@prisma/client';
import { EventEmitter } from 'events';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import { google } from 'googleapis';
import mime from 'mime-types';
import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { StorageConfig } from '../../types/config';
import {
  InstagramSuggestion,
  PhotoMetadata,
  SearchCriteria,
} from '../../types/photo';
import { LLMService } from '../llm/LLMService';
import { ChromaVectorStore } from '../vectorstore/VectorStore';

interface GoogleDrivePhotoMetadata extends PhotoMetadata {
  source: 'google_drive';
}

export class PhotoIndexer {
  private drive;
  private prisma: PrismaClient;
  private readonly BATCH_SIZE = 5; // Process 5 photos at a time
  private readonly MAX_DIMENSION = 8192; // Support up to 8K resolution
  public progressEmitter: EventEmitter;

  constructor(
    private llmService: LLMService,
    private vectorStore: ChromaVectorStore,
    private config: StorageConfig
  ) {
    this.prisma = new PrismaClient();
    this.progressEmitter = new EventEmitter();

    // Bind methods to preserve 'this' context
    this.validateAndParseDate = this.validateAndParseDate.bind(this);
    this.validateAndGetCurrentDate = this.validateAndGetCurrentDate.bind(this);

    if (config.googleDrive.enabled) {
      const auth = new google.auth.GoogleAuth({
        keyFile: config.googleDrive.credentialsPath,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
      this.drive = google.drive({ version: 'v3', auth });
    }
  }

  private isImageFile(filename: string): boolean {
    // Skip macOS metadata/resource files that start with "._"
    const basename = path.basename(filename);
    if (basename.startsWith('._')) {
      return false;
    }

    const mimeType = mime.lookup(filename);
    return mimeType ? mimeType.startsWith('image/') : false;
  }

  private debugLog(message: string, metadata?: Record<string, unknown>) {
    if (process.env.DEBUG) {
      const timestamp = new Date().toISOString();
      console.debug(`[${timestamp}] ${message}`);
      if (metadata) {
        console.debug(JSON.stringify(metadata, null, 2));
      }
    }
  }

  private showProgress(
    title: string,
    current: number,
    total: number,
    stats: Record<string, number> = {}
  ) {
    // Clear line and move to beginning
    process.stdout.write('\r\x1b[K');

    const percentage = (current / total) * 100;
    const width = 50;
    const filled = Math.round((width * percentage) / 100);
    const bar = `\x1b[36m[${'█'.repeat(filled)}${'-'.repeat(
      width - filled
    )}]\x1b[0m`; // Using block characters and cyan color

    // Format: [██████████------] 50% | 50/100 | New: 20 Skipped: 30
    let progressText = `${bar} \x1b[1m${percentage.toFixed(
      1
    )}%\x1b[0m | ${current}/${total}`;

    if (Object.keys(stats).length > 0) {
      const statsText = Object.entries(stats)
        .map(([key, value]) => `${key}: \x1b[1m${value}\x1b[0m`)
        .join(' | ');
      progressText += ` | ${statsText}`;
    }

    process.stdout.write(`${title} ${progressText}`);

    // Emit progress event
    this.progressEmitter.emit('progress', {
      current,
      total,
      stats,
    });
  }

  async indexLocalPhotos(): Promise<PhotoMetadata[]> {
    const photos: PhotoMetadata[] = [];
    let totalImages = 0;
    let processedImages = 0;
    let savedToDb = 0;
    let skippedImages = 0;
    let failedImages = 0;

    // Count total images
    for (const directory of this.config.localPaths) {
      const files = await this.scanDirectory(directory);
      const imageFiles = files.filter((file) => this.isImageFile(file));
      totalImages += imageFiles.length;
    }

    console.log(`\nStarting photo indexing - Found ${totalImages} images\n`);

    for (const directory of this.config.localPaths) {
      try {
        const files = await this.scanDirectory(directory);
        const imageFiles = files.filter((file) => this.isImageFile(file));

        for (let i = 0; i < imageFiles.length; i += this.BATCH_SIZE) {
          const batch = imageFiles.slice(i, i + this.BATCH_SIZE);

          this.debugLog(`Processing batch of ${batch.length} images`);

          const batchResults = await Promise.all(
            batch.map(async (file) => {
              try {
                const existingPhoto = await this.prisma.photo.findUnique({
                  where: {
                    path_source: {
                      path: file,
                      source: 'local',
                    },
                  },
                });

                if (existingPhoto) {
                  this.debugLog(`Skipping existing file: ${file}`);
                  skippedImages++;
                  return this.dbPhotoToPhotoMetadata(existingPhoto);
                }

                const photo = await this.analyzePhoto(file);
                await this.savePhotoToDb(photo);
                savedToDb++;
                return photo;
              } catch (error) {
                this.debugLog(`Error processing ${file}:`, { error });
                console.error(`Error processing ${file}:`, error);
                failedImages++;
                return null;
              } finally {
                processedImages++;
                this.showProgress('Indexing:', processedImages, totalImages, {
                  New: savedToDb,
                  Skipped: skippedImages,
                  Failed: failedImages,
                });
              }
            })
          );

          photos.push(
            ...batchResults.filter((p): p is PhotoMetadata => p !== null)
          );
        }
      } catch (error) {
        console.error(`\nError processing directory ${directory}:`, error);
      }
    }

    // Move to new line after progress bar
    console.log('\n');
    console.log(
      `Indexing completed - Total: ${totalImages}, New: ${savedToDb}, Skipped: ${skippedImages}, Failed: ${failedImages}\n`
    );

    return photos;
  }

  private async scanDirectory(dir: string): Promise<string[]> {
    const files: string[] = [];

    async function scan(currentDir: string) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    }

    await scan(dir);
    return files;
  }

  async indexGoogleDrivePhotos(): Promise<PhotoMetadata[]> {
    if (!this.config.googleDrive.enabled || !this.drive) {
      throw new Error('Google Drive integration not configured');
    }

    const photos: PhotoMetadata[] = [];
    let pageToken: string | undefined;

    this.debugLog('Starting Google Drive photo indexing');

    do {
      const response = await this.drive.files.list({
        q: "mimeType contains 'image/'",
        fields:
          'nextPageToken, files(id, name, mimeType, createdTime, imageMediaMetadata)',
        pageToken,
        pageSize: this.BATCH_SIZE,
      });

      const files = response.data.files;
      if (files && files.length > 0) {
        this.debugLog(`Processing ${files.length} files from Google Drive`);

        const batchPromises = files.map(async (file) => {
          try {
            const dest = path.join(
              process.env.PHOTOS_CACHE_DIR || './cache',
              file.id!
            );

            this.debugLog(`Downloading file: ${file.name}`, {
              id: file.id,
              mimeType: file.mimeType,
              createdTime: file.createdTime,
              imageMediaMetadata: file.imageMediaMetadata,
            });

            await this.downloadGoogleDriveFile(file.id!, dest);
            const photo = await this.analyzePhoto(dest);

            // Log high-resolution image details
            if (
              photo.technicalInfo?.dimensions &&
              (photo.technicalInfo.dimensions.width > this.MAX_DIMENSION ||
                photo.technicalInfo.dimensions.height > this.MAX_DIMENSION)
            ) {
              this.debugLog(
                `High resolution Google Drive image: ${file.name}`,
                {
                  dimensions: photo.technicalInfo.dimensions,
                  id: file.id,
                }
              );
            }

            const result: GoogleDrivePhotoMetadata = {
              ...photo,
              source: 'google_drive',
              path: `gdrive://${file.id}`,
            };

            // Clean up the temporary file
            await fs.unlink(dest);

            this.debugLog(
              `Successfully processed Google Drive file: ${file.name}`,
              {
                id: file.id,
                photoId: result.id,
                subjects: result.aiMetadata.subjects,
              }
            );

            return result;
          } catch (error) {
            this.debugLog(`Error processing Google Drive file: ${file.name}`, {
              id: file.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        const validResults = batchResults.filter(
          (p): p is GoogleDrivePhotoMetadata =>
            p !== null && p.source === 'google_drive'
        );
        photos.push(...validResults);

        if (response.data.nextPageToken) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    this.debugLog(
      `Completed Google Drive indexing. Total photos processed: ${photos.length}`
    );
    return photos;
  }

  private async downloadGoogleDriveFile(
    fileId: string,
    destPath: string
  ): Promise<void> {
    if (!this.drive) throw new Error('Google Drive not initialized');

    const dest = createWriteStream(destPath);
    const response = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    await new Promise<void>((resolve, reject) => {
      response.data
        .pipe(dest)
        .on('finish', () => resolve())
        .on('error', (err) => reject(err));
    });
  }

  async analyzePhoto(path: string): Promise<PhotoMetadata> {
    this.debugLog(`Analyzing photo: ${path}`);

    // Extract EXIF data first to get dimensions
    const exifData = await this.extractExifData(path);

    let processedImagePath = path;

    // If image is higher resolution than 8K, create a temporary resized version for AI analysis
    if (
      exifData.technical.dimensions.width > this.MAX_DIMENSION ||
      exifData.technical.dimensions.height > this.MAX_DIMENSION
    ) {
      this.debugLog(`Resizing high-resolution image for AI analysis`, {
        originalDimensions: exifData.technical.dimensions,
        maxDimension: this.MAX_DIMENSION,
      });

      const tempPath = `${path}_resized`;
      await sharp(path)
        .resize(this.MAX_DIMENSION, this.MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFile(tempPath);

      processedImagePath = tempPath;
      this.debugLog('Image resized successfully for AI processing');
    }

    // Analyze image with LLM
    this.debugLog('Starting LLM analysis');
    const aiMetadata = await this.llmService.analyzeImage(processedImagePath);
    this.debugLog('LLM analysis completed', {
      subjects: aiMetadata.subjects,
      environment: aiMetadata.environment,
    });

    // Generate embedding for semantic search using LLM service instead of vector store
    const description = [
      ...aiMetadata.subjects,
      aiMetadata.environment,
      aiMetadata.description,
      ...aiMetadata.tags,
    ]
      .filter(Boolean)
      .join(' ');
    this.debugLog('Generating vector embedding');
    const vectorEmbedding = await this.llmService.generateEmbedding(
      description
    );

    // Extract album from path (parent folder name)
    const pathParts = path.split('/');
    let albumName = pathParts.slice(-2, -1)[0];

    // If album name is Processed or Backups, go one level up
    if (albumName) {
      if (albumName.toLowerCase() === 'processed') {
        albumName = pathParts.slice(-3, -2)[0];
      }
      if (albumName.toLowerCase() === 'backups') {
        albumName = pathParts.slice(-4, -3)[0];
      }
    }

    const photo: PhotoMetadata = {
      id: uuidv4(),
      filename: path.split('/').pop()!,
      path,
      source: 'local',
      dateTime: this.validateAndParseDate(exifData.dateTime),
      location: exifData.location,
      aiMetadata: {
        ...aiMetadata,
        album: albumName,
      },
      technicalInfo: exifData.technical,
      vectorEmbedding: vectorEmbedding,
      lastIndexed: this.validateAndGetCurrentDate(),
      instagramSuggested: undefined,
    };

    // Clean up temporary resized file if it was created
    if (processedImagePath !== path) {
      await fs.unlink(processedImagePath);
      this.debugLog('Cleaned up temporary resized image');
    }

    // Add to vector store
    await this.vectorStore.addDocument(photo.id, vectorEmbedding, {
      path: photo.path,
      description,
      subjects: photo.aiMetadata.subjects,
      colors: photo.aiMetadata.colors,
      album: photo.aiMetadata.album,
    });

    this.debugLog(`Photo analysis completed`, {
      id: photo.id,
      filename: photo.filename,
      dimensions: photo.technicalInfo.dimensions,
    });

    return photo;
  }

  private async extractExifData(filePath: string) {
    this.debugLog(`Extracting EXIF data from: ${filePath}`);

    const image = sharp(filePath);
    const metadata = await image.metadata();

    let dateTime: Date | undefined;
    if (metadata.exif) {
      try {
        // EXIF dates can sometimes be strings or buffers, handle both cases
        const exifDate = metadata.exif.toString();
        this.debugLog('Parsing EXIF date', { exifDate });

        // Try parsing various date formats
        let parsedDate: Date | null = null;

        // Try direct Date parsing
        parsedDate = new Date(exifDate);
        if (isNaN(parsedDate.getTime())) {
          // Try parsing common EXIF date format: YYYY:MM:DD HH:mm:ss
          const match = exifDate.match(
            /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/
          );
          if (match) {
            const [_, year, month, day, hour, minute, second] = match;
            parsedDate = new Date(
              parseInt(year),
              parseInt(month) - 1,
              parseInt(day),
              parseInt(hour),
              parseInt(minute),
              parseInt(second)
            );
          }
        }

        dateTime =
          parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : undefined;
        this.debugLog('EXIF date parsing result', {
          original: exifDate,
          parsed: dateTime?.toISOString() ?? 'invalid',
        });
      } catch (error) {
        this.debugLog('Failed to parse EXIF date', { error });
      }
    }

    return {
      dateTime: this.validateDate(dateTime),
      location: undefined,
      technical: {
        dimensions: {
          width: metadata.width || 0,
          height: metadata.height || 0,
        },
        format: metadata.format,
        size: metadata.size,
        space: metadata.space,
        hasAlpha: metadata.hasAlpha,
        channels: metadata.channels,
      },
    };
  }

  private validateDate(date: Date | undefined | null): Date | undefined {
    // Handle non-date inputs
    if (!date) return undefined;

    // If it's a string or number, try to create a valid date
    if (!(date instanceof Date)) {
      try {
        const d = new Date(date);
        return isNaN(d.getTime()) ? undefined : d;
      } catch {
        return undefined;
      }
    }

    // For Date objects, verify they are valid
    return isNaN(date.getTime()) ? undefined : date;
  }

  private validateAndParseDate(date: any): Date | undefined {
    if (!date) return undefined;

    // If already a valid Date object, just validate it
    if (date instanceof Date) {
      return isNaN(date.getTime()) ? undefined : date;
    }

    try {
      // Try parsing the date value
      const parsedDate = new Date(date);
      return isNaN(parsedDate.getTime()) ? undefined : parsedDate;
    } catch {
      return undefined;
    }
  }

  private validateAndGetCurrentDate(): Date {
    const now = new Date();
    if (isNaN(now.getTime())) {
      // If current time is somehow invalid, use Unix timestamp
      const timestamp = Date.now();
      return new Date(timestamp);
    }
    return now;
  }

  async search(criteria: SearchCriteria): Promise<PhotoMetadata[]> {
    // Start with semantic search if available
    let matchingIds = new Set<string>();
    if (criteria.semanticSearch) {
      const queryEmbedding = await this.llmService.generateEmbedding(
        criteria.semanticSearch
      );
      const semanticResults = await this.vectorStore.search(queryEmbedding, 50);
      semanticResults.forEach((result) => matchingIds.add(result.id));
    }

    // Apply additional filters
    const filters: Array<(photo: PhotoMetadata) => boolean> = [];

    if (criteria.subjects?.length) {
      filters.push((photo) =>
        criteria.subjects!.some((subject) =>
          photo.aiMetadata.subjects.some((s) =>
            s.toLowerCase().includes(subject.toLowerCase())
          )
        )
      );
    }

    if (criteria.colors?.length) {
      filters.push((photo) =>
        criteria.colors!.some((color) =>
          photo.aiMetadata.colors.some((c) =>
            c.toLowerCase().includes(color.toLowerCase())
          )
        )
      );
    }

    if (criteria.patterns?.length) {
      filters.push((photo) =>
        criteria.patterns!.some((pattern) =>
          photo.aiMetadata.patterns.some((p) =>
            p.toLowerCase().includes(pattern.toLowerCase())
          )
        )
      );
    }

    if (criteria.season) {
      filters.push(
        (photo) =>
          photo.aiMetadata.season?.toLowerCase() ===
          criteria.season?.toLowerCase()
      );
    }

    if (criteria.startDate) {
      filters.push((photo) =>
        photo.dateTime ? photo.dateTime >= criteria.startDate! : false
      );
    }

    if (criteria.endDate) {
      filters.push((photo) =>
        photo.dateTime ? photo.dateTime <= criteria.endDate! : false
      );
    }

    if (criteria.location) {
      filters.push((photo) =>
        photo.location?.place
          ? photo.location.place
              .toLowerCase()
              .includes(criteria.location!.toLowerCase())
          : false
      );
    }

    if (criteria.album) {
      filters.push(
        (photo) =>
          photo.aiMetadata.album?.toLowerCase() ===
          criteria.album?.toLowerCase()
      );
    }

    // Fetch photos from database/storage and apply filters
    // This is a placeholder implementation - in production, you'd want to:
    // 1. Store photos in a database
    // 2. Use database queries for filtering
    // 3. Implement pagination
    const allPhotos = await this.getAllPhotos();

    let results = allPhotos.filter((photo) => {
      // If we have semantic results, only include those photos
      if (matchingIds.size > 0 && !matchingIds.has(photo.id)) {
        return false;
      }

      // Apply all other filters
      return filters.every((filter) => filter(photo));
    });

    // Sort by relevance if semantic search was used
    if (criteria.semanticSearch) {
      results.sort((a, b) => {
        const scoreA = matchingIds.has(a.id) ? 1 : 0;
        const scoreB = matchingIds.has(b.id) ? 1 : 0;
        return scoreB - scoreA;
      });
    }

    return results.slice(0, 20); // Limit results
  }

  async getDailySuggestion(): Promise<InstagramSuggestion> {
    // Get all photos that haven't been suggested recently
    const allPhotos = await this.getAllPhotos();
    const eligiblePhotos = allPhotos.filter((photo) => {
      if (!photo.instagramSuggested) return true;

      // Only suggest photos that haven't been suggested in the last 90 days
      const daysSinceLastSuggestion = Math.floor(
        (Date.now() - photo.instagramSuggested.getTime()) /
          (1000 * 60 * 60 * 24)
      );
      return daysSinceLastSuggestion > 90;
    });

    if (eligiblePhotos.length === 0) {
      throw new Error('No eligible photos for daily suggestion');
    }

    // Score photos based on various criteria
    const scoredPhotos = await Promise.all(
      eligiblePhotos.map(async (photo) => {
        let score = 0;

        // Prefer photos with more subjects
        score += photo.aiMetadata.subjects.length * 2;

        // Prefer photos with more detailed descriptions
        score += photo.aiMetadata.description.split(' ').length * 0.1;

        // Prefer seasonal photos
        const currentMonth = new Date().getMonth();
        const seasons = {
          winter: [11, 0, 1],
          spring: [2, 3, 4],
          summer: [5, 6, 7],
          autumn: [8, 9, 10],
        };
        if (photo.aiMetadata.season) {
          const seasonMonths =
            seasons[
              photo.aiMetadata.season.toLowerCase() as keyof typeof seasons
            ];
          if (seasonMonths.includes(currentMonth)) {
            score += 5;
          }
        }

        // Consider photo quality metrics if available
        if (photo.technicalInfo) {
          // Add quality-based scoring here
        }

        return { photo, score };
      })
    );

    // Sort by score and pick the highest-scoring photo
    scoredPhotos.sort((a, b) => b.score - a.score);
    const selectedPhoto = scoredPhotos[0].photo;

    // Generate Instagram-ready content
    const caption = await this.llmService.generateInstagramCaption(
      selectedPhoto
    );
    const hashtags = await this.llmService.generateHashtags(selectedPhoto);

    // Generate reason for selection
    const reason = `This photo was selected because it features ${selectedPhoto.aiMetadata.subjects.join(
      ', '
    )} 
      in a beautiful ${selectedPhoto.aiMetadata.environment} setting${
      selectedPhoto.aiMetadata.season
        ? ` during ${selectedPhoto.aiMetadata.season}`
        : ''
    }. The image showcases ${selectedPhoto.aiMetadata.colors
      .slice(0, 2)
      .join(' and ')} colors 
    and ${
      selectedPhoto.aiMetadata.patterns.length > 0
        ? selectedPhoto.aiMetadata.patterns.join(', ') + ' patterns'
        : 'interesting patterns'
    }.`;

    // Update the photo's Instagram suggestion date
    await this.updatePhotoInstagramDate(selectedPhoto.id);

    return {
      photo: selectedPhoto,
      reason,
      suggestedCaption: caption,
      suggestedHashtags: hashtags,
    };
  }

  private async getAllPhotos(): Promise<PhotoMetadata[]> {
    const dbPhotos = await this.prisma.photo.findMany();
    // Use arrow function to preserve 'this' context
    return dbPhotos.map((photo) => this.dbPhotoToPhotoMetadata(photo));
  }

  private async updatePhotoInstagramDate(photoId: string): Promise<void> {
    const now = this.validateAndGetCurrentDate();
    await this.prisma.photo.update({
      where: { id: photoId },
      data: { instagramSuggested: now.toISOString() },
    });
  }

  private async savePhotoToDb(photo: PhotoMetadata): Promise<void> {
    try {
      const { aiMetadata, technicalInfo, location, ...rest } = photo;

      // Always use a fresh current time for lastIndexed
      const lastIndexed = this.validateAndGetCurrentDate();

      // Ensure vector embedding is properly serialized
      const vectorEmbeddingStr = photo.vectorEmbedding
        ? JSON.stringify(Array.from(photo.vectorEmbedding))
        : null;

      const photoData = {
        ...rest,
        lastIndexed: lastIndexed.toISOString(),
        dateTime:
          this.validateAndParseDate(photo.dateTime)?.toISOString() ?? null,
        instagramSuggested:
          this.validateAndParseDate(photo.instagramSuggested)?.toISOString() ??
          null,
        vectorEmbedding: vectorEmbeddingStr,
        width: technicalInfo.dimensions?.width,
        height: technicalInfo.dimensions?.height,
        format: technicalInfo.format,
        fileSize: technicalInfo.size,
        colorSpace: technicalInfo.space,
        hasAlpha: technicalInfo.hasAlpha,
        channels: technicalInfo.channels,
        latitude: location?.latitude,
        longitude: location?.longitude,
        locationPlace: location?.place,
        subjectsJson: JSON.stringify(aiMetadata.subjects),
        environment: aiMetadata.environment,
        description: aiMetadata.description,
        colorsJson: JSON.stringify(aiMetadata.colors),
        patternsJson: JSON.stringify(aiMetadata.patterns),
        tagsJson: JSON.stringify(aiMetadata.tags),
        album: aiMetadata.album,
        season: aiMetadata.season,
        modelName: aiMetadata.modelInfo?.name,
        modelVersion: aiMetadata.modelInfo?.version,
        modelType: aiMetadata.modelInfo?.type,
      };

      await this.prisma.photo.create({
        data: photoData,
      });

      this.debugLog(`Saved to database: ${photo.filename}`, {
        dates: {
          lastIndexed: photoData.lastIndexed,
          dateTime: photoData.dateTime,
          instagramSuggested: photoData.instagramSuggested,
        },
      });
    } catch (error) {
      this.debugLog(`Database error`, { error });
      throw error;
    }
  }

  private dbPhotoToPhotoMetadata(dbPhoto: any): PhotoMetadata {
    return {
      id: dbPhoto.id,
      filename: dbPhoto.filename,
      path: dbPhoto.path,
      source: dbPhoto.source as 'local' | 'google_drive',
      dateTime: this.validateAndParseDate(dbPhoto.dateTime),
      lastIndexed:
        this.validateAndParseDate(dbPhoto.lastIndexed) ||
        this.validateAndGetCurrentDate(),
      instagramSuggested: this.validateAndParseDate(dbPhoto.instagramSuggested),
      vectorEmbedding: dbPhoto.vectorEmbedding
        ? Array.from(new Float32Array(JSON.parse(dbPhoto.vectorEmbedding)))
        : undefined,
      technicalInfo: {
        dimensions: {
          width: dbPhoto.width ?? 0,
          height: dbPhoto.height ?? 0,
        },
        format: dbPhoto.format,
        size: dbPhoto.fileSize,
        space: dbPhoto.colorSpace,
        hasAlpha: dbPhoto.hasAlpha,
        channels: dbPhoto.channels,
      },
      location:
        dbPhoto.latitude || dbPhoto.longitude || dbPhoto.locationPlace
          ? {
              latitude: dbPhoto.latitude,
              longitude: dbPhoto.longitude,
              place: dbPhoto.locationPlace,
            }
          : undefined,
      aiMetadata: {
        subjects: JSON.parse(dbPhoto.subjectsJson),
        environment: dbPhoto.environment ?? undefined,
        description: dbPhoto.description,
        colors: JSON.parse(dbPhoto.colorsJson),
        patterns: JSON.parse(dbPhoto.patternsJson),
        album: dbPhoto.album ?? undefined,
        tags: JSON.parse(dbPhoto.tagsJson),
        season: dbPhoto.season ?? undefined,
        modelInfo: dbPhoto.modelName
          ? {
              name: dbPhoto.modelName,
              version: dbPhoto.modelVersion ?? undefined,
              type: dbPhoto.modelType as 'local' | 'api',
            }
          : undefined,
      },
    };
  }

  /**
   * Update the LLM service
   */
  updateLLMService(newService: LLMService): void {
    this.llmService = newService;
  }

  /**
   * Update the vector store
   */
  updateVectorStore(newStore: ChromaVectorStore): void {
    this.vectorStore = newStore;
  }
}
