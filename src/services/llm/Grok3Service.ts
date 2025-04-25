import axios from 'axios';
import fs from 'fs';
import { LLMConfig } from '../../types/config';
import { PhotoMetadata } from '../../types/photo';
import { LLMCacheService } from './LLMCacheService';
import { ImageAnalysisResult, LLMService } from './LLMService';

export class Grok3Service implements LLMService {
  private baseUrl: string;
  private cacheService: LLMCacheService | null = null;
  private cacheEnabled = true;

  constructor(private config: LLMConfig, cacheService?: LLMCacheService) {
    this.baseUrl = 'https://api.grok.x.ai/v1'; // Example URL, replace with actual Grok3 API endpoint

    if (cacheService) {
      this.cacheService = cacheService;
    }
  }

  enableCache(enabled: boolean): void {
    this.cacheEnabled = enabled;
  }

  async clearCache(): Promise<void> {
    if (this.cacheService) {
      await this.cacheService.clearCache();
    }
  }

  async analyzeImage(imagePath: string): Promise<ImageAnalysisResult> {
    // Generate a cache key based on file stats and path for image analysis
    let cacheKey = `${imagePath}`;

    // Check cache first if enabled and available
    if (this.cacheEnabled && this.cacheService) {
      try {
        // Use file stats to make a more accurate cache key
        const fileStats = await fs.promises.stat(imagePath);
        cacheKey = `${imagePath}_${fileStats.size}_${fileStats.mtimeMs}`;

        const cachedResult =
          await this.cacheService.getCachedResult<ImageAnalysisResult>(
            'analyzeImage',
            cacheKey
          );

        if (cachedResult) {
          console.log('Using cached image analysis result');
          return cachedResult;
        }
      } catch (error) {
        // Continue if cache lookup fails
        console.log('Cache lookup failed, proceeding with analysis');
      }
    }

    const imageData = await fs.promises.readFile(imagePath);
    const base64Image = imageData.toString('base64');

    const response = await axios.post(
      `${this.baseUrl}/analyze`,
      {
        image: base64Image,
        analysis_type: 'wildlife',
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Transform Grok3's response format to our ImageAnalysisResult format
    const result = response.data;
    const analysisResult: ImageAnalysisResult = {
      subjects: result.detected_animals || [],
      colors: result.dominant_colors || [],
      patterns: result.patterns || [],
      season: result.detected_season,
      environment: result.environment_description,
      description: result.detailed_description,
      tags: result.suggested_tags || [],
    };

    // Cache the result if caching is enabled
    if (this.cacheEnabled && this.cacheService) {
      await this.cacheService.setCachedResult(
        'analyzeImage',
        cacheKey,
        analysisResult
      );
    }

    return analysisResult;
  }

  async generateInstagramCaption(photo: PhotoMetadata): Promise<string> {
    const cacheKey = `caption_${photo.id}`;

    // Check cache first if enabled and available
    if (this.cacheEnabled && this.cacheService) {
      const cachedResult = await this.cacheService.getCachedResult<string>(
        'generateInstagramCaption',
        cacheKey
      );

      if (cachedResult) {
        return cachedResult;
      }
    }

    const response = await axios.post(
      `${this.baseUrl}/generate/caption`,
      {
        subjects: photo.aiMetadata.subjects,
        environment: photo.aiMetadata.environment,
        description: photo.aiMetadata.description,
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const caption = response.data.caption;

    // Cache the result if enabled
    if (this.cacheEnabled && this.cacheService) {
      await this.cacheService.setCachedResult(
        'generateInstagramCaption',
        cacheKey,
        caption
      );
    }

    return caption;
  }

  async generateHashtags(photo: PhotoMetadata): Promise<string[]> {
    const cacheKey = `hashtags_${photo.id}`;

    // Check cache first if enabled and available
    if (this.cacheEnabled && this.cacheService) {
      const cachedResult = await this.cacheService.getCachedResult<string[]>(
        'generateHashtags',
        cacheKey
      );

      if (cachedResult) {
        return cachedResult;
      }
    }

    const response = await axios.post(
      `${this.baseUrl}/generate/hashtags`,
      {
        subjects: photo.aiMetadata.subjects,
        environment: photo.aiMetadata.environment,
        colors: photo.aiMetadata.colors,
        season: photo.aiMetadata.season,
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const hashtags = response.data.hashtags.map((tag: string) =>
      tag.replace('#', '')
    );

    // Cache the result if enabled
    if (this.cacheEnabled && this.cacheService) {
      await this.cacheService.setCachedResult(
        'generateHashtags',
        cacheKey,
        hashtags
      );
    }

    return hashtags;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const cacheKey = text;

    // Check cache first if enabled and available
    if (this.cacheEnabled && this.cacheService) {
      const cachedResult = await this.cacheService.getCachedResult<number[]>(
        'generateEmbedding',
        cacheKey
      );

      if (cachedResult) {
        return cachedResult;
      }
    }

    const response = await axios.post(
      `${this.baseUrl}/embeddings`,
      {
        text,
        model: 'text-embedding',
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const embedding = response.data.embedding;

    // Cache the result if enabled
    if (this.cacheEnabled && this.cacheService) {
      await this.cacheService.setCachedResult(
        'generateEmbedding',
        cacheKey,
        embedding
      );
    }

    return embedding;
  }
}
