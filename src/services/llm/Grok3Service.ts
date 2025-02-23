import axios from 'axios';
import fs from 'fs';
import { LLMConfig } from '../../types/config';
import { PhotoMetadata } from '../../types/photo';
import { ImageAnalysisResult, LLMService } from './LLMService';

export class Grok3Service implements LLMService {
  private baseUrl: string;

  constructor(private config: LLMConfig) {
    this.baseUrl = 'https://api.grok.x.ai/v1'; // Example URL, replace with actual Grok3 API endpoint
  }

  async analyzeImage(imagePath: string): Promise<ImageAnalysisResult> {
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
    return {
      subjects: result.detected_animals || [],
      colors: result.dominant_colors || [],
      patterns: result.patterns || [],
      season: result.detected_season,
      environment: result.environment_description,
      description: result.detailed_description,
      tags: result.suggested_tags || [],
    };
  }

  async generateInstagramCaption(photo: PhotoMetadata): Promise<string> {
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

    return response.data.caption;
  }

  async generateHashtags(photo: PhotoMetadata): Promise<string[]> {
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

    return response.data.hashtags.map((tag: string) => tag.replace('#', ''));
  }

  async generateEmbedding(text: string): Promise<number[]> {
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

    return response.data.embedding;
  }
}
