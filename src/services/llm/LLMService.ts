import { LLMConfig } from '../../types/config';
import { PhotoMetadata } from '../../types/photo';

export interface ImageAnalysisResult {
  subjects: string[];
  colors: string[];
  patterns: string[];
  season?: string;
  environment?: string;
  description: string;
  tags: string[];
}

export interface LLMService {
  analyzeImage(imagePath: string): Promise<ImageAnalysisResult>;
  generateInstagramCaption(photo: PhotoMetadata): Promise<string>;
  generateHashtags(photo: PhotoMetadata): Promise<string[]>;
  generateEmbedding(text: string): Promise<number[]>;
  clearCache?(): Promise<void>; // Optional method for clearing cache
  enableCache(enabled: boolean): void; // Method to toggle caching
}

export class OpenAIService implements LLMService {
  constructor(private config: LLMConfig) {}

  async analyzeImage(imagePath: string): Promise<ImageAnalysisResult> {
    console.log('Analyzing image:', imagePath, 'with config:', this.config);
    // Implementation using OpenAI's GPT-4 Vision API
    throw new Error('Not implemented');
  }

  async generateInstagramCaption(photo: PhotoMetadata): Promise<string> {
    console.log(
      'Generating caption for photo:',
      photo,
      'with config:',
      this.config
    );
    // Implementation using OpenAI's completion API
    throw new Error('Not implemented');
  }

  async generateHashtags(photo: PhotoMetadata): Promise<string[]> {
    console.log(
      'Generating hashtags for photo:',
      photo,
      'with config:',
      this.config
    );
    // Implementation using OpenAI's completion API
    throw new Error('Not implemented');
  }

  async generateEmbedding(text: string): Promise<number[]> {
    console.log(
      'Generating embedding for text:',
      text,
      'with config:',
      this.config
    );
    // Implementation using OpenAI's embeddings API
    throw new Error('Not implemented');
  }

  enableCache(enabled: boolean): void {
    console.log('Cache enabled:', enabled);
    // Default implementation does nothing
  }
}

export class Grok3Service implements LLMService {
  constructor(private config: LLMConfig) {}

  async analyzeImage(imagePath: string): Promise<ImageAnalysisResult> {
    console.log('Analyzing image:', imagePath, 'with config:', this.config);
    // Implementation using Grok3 API
    throw new Error('Not implemented');
  }

  async generateInstagramCaption(photo: PhotoMetadata): Promise<string> {
    console.log(
      'Generating caption for photo:',
      photo,
      'with config:',
      this.config
    );
    // Implementation using Grok3 API
    throw new Error('Not implemented');
  }

  async generateHashtags(photo: PhotoMetadata): Promise<string[]> {
    console.log(
      'Generating hashtags for photo:',
      photo,
      'with config:',
      this.config
    );
    // Implementation using Grok3 API
    throw new Error('Not implemented');
  }

  async generateEmbedding(text: string): Promise<number[]> {
    console.log(
      'Generating embedding for text:',
      text,
      'with config:',
      this.config
    );
    // Implementation using Grok3 API
    throw new Error('Not implemented');
  }

  enableCache(enabled: boolean): void {
    console.log('Cache enabled:', enabled);
    // Default implementation does nothing
  }
}
