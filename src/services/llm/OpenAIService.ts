import fs from 'fs/promises';
import OpenAI from 'openai';
import path from 'path';
import sharp from 'sharp';
import { LLMConfig } from '../../types/config';
import { PhotoMetadata } from '../../types/photo';
import { ImageAnalysisResult, LLMService } from './LLMService';

export class OpenAIService implements LLMService {
  private client: OpenAI;
  private maxRetries = 0;
  private retryDelay = 1000;
  private readonly SUPPORTED_FORMATS = ['jpeg', 'jpg', 'png', 'webp', 'gif'];
  private readonly MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
  private readonly MAX_DIMENSION = 2048;
  private readonly MIN_DIMENSION = 512;

  constructor(private config: LLMConfig) {
    const { apiKey } = this.config;
    this.client = new OpenAI({ apiKey });
  }

  private debugLog(message: string, metadata?: Record<string, unknown>) {
    if (process.env.DEBUG) {
      const timestamp = new Date().toISOString();
      console.debug(`[OpenAI] ${timestamp} - ${message}`);
      if (metadata) {
        console.debug(JSON.stringify(metadata, null, 2));
      }
    }
  }

  private async retryWithDelay<T>(
    operation: () => Promise<T>,
    attempt: number = 1
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      if (attempt >= this.maxRetries) {
        throw new Error(
          `Failed after ${this.maxRetries} attempts: ${error.message}`
        );
      }

      // Handle rate limiting
      if (error.status === 429) {
        const delay = (error.response?.headers?.['retry-after'] || 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.retryWithDelay(operation, attempt);
      }

      // General retry with exponential backoff
      const delay = this.retryDelay * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.retryWithDelay(operation, attempt + 1);
    }
  }

  private async validateImage(imagePath: string): Promise<void> {
    const stats = await fs.stat(imagePath);
    if (stats.size > this.MAX_FILE_SIZE) {
      throw new Error(
        `Image size exceeds maximum allowed size of ${
          this.MAX_FILE_SIZE / (1024 * 1024)
        }MB`
      );
    }

    const metadata = await sharp(imagePath).metadata();
    const format = metadata.format?.toLowerCase();

    if (!format || !this.SUPPORTED_FORMATS.includes(format)) {
      throw new Error(
        `Unsupported image format: ${format}. Supported formats are: ${this.SUPPORTED_FORMATS.join(
          ', '
        )}`
      );
    }

    if (format === 'gif' && (metadata.pages || 0) > 1) {
      console.warn(
        'Animated GIF detected: Only the first frame will be analyzed'
      );
    }
  }

  private async preprocessImage(imagePath: string): Promise<string> {
    await this.validateImage(imagePath);
    const imageInfo = await sharp(imagePath).metadata();

    let { width, height } = imageInfo;
    if (!width || !height) {
      throw new Error('Unable to determine image dimensions');
    }

    // Calculate new dimensions while maintaining aspect ratio
    const aspectRatio = width / height;
    if (width > this.MAX_DIMENSION || height > this.MAX_DIMENSION) {
      if (width > height) {
        width = this.MAX_DIMENSION;
        height = Math.round(width / aspectRatio);
      } else {
        height = this.MAX_DIMENSION;
        width = Math.round(height * aspectRatio);
      }
    } else if (width < this.MIN_DIMENSION || height < this.MIN_DIMENSION) {
      if (width < height) {
        width = this.MIN_DIMENSION;
        height = Math.round(width / aspectRatio);
      } else {
        height = this.MIN_DIMENSION;
        width = Math.round(height * aspectRatio);
      }
    }

    // Create processed image path
    const processedPath = path.join(
      path.dirname(imagePath),
      `processed_${Date.now()}_${path.basename(imagePath)}`
    );

    try {
      // Process image: resize if needed, convert to JPEG, and optimize
      await sharp(imagePath)
        .resize(width, height, {
          fit: 'inside',
          withoutEnlargement: width < imageInfo.width!,
        })
        .jpeg({
          quality: 85,
          progressive: true,
        })
        .toFile(processedPath);

      // Check final file size and compress further if needed
      const stats = await fs.stat(processedPath);
      if (stats.size > this.MAX_FILE_SIZE) {
        const quality = Math.floor(85 * (this.MAX_FILE_SIZE / stats.size));
        await sharp(processedPath)
          .jpeg({
            quality: Math.max(30, quality), // Don't go below 30% quality
            progressive: true,
          })
          .toFile(processedPath + '_compressed');

        await fs.unlink(processedPath);
        await fs.rename(processedPath + '_compressed', processedPath);

        // Final size check
        const finalStats = await fs.stat(processedPath);
        if (finalStats.size > this.MAX_FILE_SIZE) {
          throw new Error('Unable to compress image to meet size requirements');
        }
      }

      return processedPath;
    } catch (error) {
      // Clean up any temporary files
      await fs.unlink(processedPath).catch(() => {});
      throw error;
    }
  }

  async analyzeImage(imagePath: string): Promise<ImageAnalysisResult> {
    let processedImagePath: string | null = null;

    return this.retryWithDelay(async () => {
      try {
        processedImagePath = await this.preprocessImage(imagePath);
        const imageData = await fs.readFile(processedImagePath);
        const base64Image = imageData.toString('base64');

        this.debugLog('Sending request to OpenAI Vision API...');
        const response = await this.client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'You are a wildlife photography expert tasked with analyzing photos (mostly from India). Provide detailed, accurate information about the wildlife, environment, and photographic elements in each image.',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Analyze this wildlife photo and provide the following information in a structured format:
                1. SUBJECTS: List all animals/wildlife subjects visible in the image
                2. COLORS: List dominant colors in the image
                3. PATTERNS: Describe any notable patterns or textures
                4. SEASON: If apparent from the environment or context. Indian seasons.
                5. ENVIRONMENT: Detailed description of the habitat/setting
                6. TAGS: Relevant keywords for searching (max 10)
                7. DESCRIPTION: A detailed, professional description of the photo

                Format each section clearly with headings.`,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 1000,
        });

        this.debugLog('Received response from OpenAI');
        const content = response.choices[0].message.content;
        if (!content) throw new Error('No analysis received from OpenAI');

        return this.parseAnalysisResponse(content);
      } catch (error) {
        console.error('Error in OpenAI Vision API analysis:', error);
        throw error;
      } finally {
        // Clean up processed image
        if (processedImagePath) {
          await fs.unlink(processedImagePath).catch(() => {});
        }
      }
    });
  }

  async generateInstagramCaption(photo: PhotoMetadata): Promise<string> {
    return this.retryWithDelay(async () => {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content:
              'You are a wildlife photography expert creating engaging Instagram captions. Write captions that are informative, engaging, and conservation-minded.',
          },
          {
            role: 'user',
            content: `Generate an engaging Instagram caption for this wildlife photo using these details:
            Subject: ${photo.aiMetadata.subjects.join(', ')}
            Environment: ${photo.aiMetadata.environment}
            Description: ${photo.aiMetadata.description}
            Season: ${photo.aiMetadata.season || 'Not specified'}

            Make it:
            1. Engaging and informative
            2. Include interesting facts about the subject
            3. End with a thought-provoking question
            4. Keep it under 200 characters`,
          },
        ],
        max_tokens: 200,
      });

      return response.choices[0].message.content || '';
    });
  }

  async generateHashtags(photo: PhotoMetadata): Promise<string[]> {
    return this.retryWithDelay(async () => {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content:
              'You are a wildlife photography expert creating relevant hashtags for Instagram. Focus on wildlife, nature, and photography communities.',
          },
          {
            role: 'user',
            content: `Generate relevant Instagram hashtags for this wildlife photo:
            Subjects: ${photo.aiMetadata.subjects.join(', ')}
            Environment: ${photo.aiMetadata.environment}
            Colors: ${photo.aiMetadata.colors.join(', ')}
            Season: ${photo.aiMetadata.season || 'Not specified'}

            Rules:
            1. Include mix of popular and niche hashtags
            2. Focus on wildlife photography and nature
            3. Include location/habitat relevant tags
            4. Maximum 15 hashtags
            5. No spaces in hashtags
            6. No special characters except underscores
            7. Return as simple comma-separated list without # symbol`,
          },
        ],
        max_tokens: 100,
      });

      const content = response.choices[0].message.content || '';
      return content
        .split(/[,\n]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .map((tag) => tag.replace(/[^a-zA-Z0-9_]/g, ''))
        .filter((tag) => tag.length > 0 && tag.length <= 30); // Instagram hashtag length limit
    });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return this.retryWithDelay(async () => {
      const response = await this.client.embeddings.create({
        input: text,
        model: 'text-embedding-ada-002',
      });

      return response.data[0].embedding;
    });
  }

  private parseAnalysisResponse(content: string): ImageAnalysisResult {
    const sections = content.split(/\n\s*\n/); // Split by double newline
    const result: ImageAnalysisResult = {
      subjects: [],
      colors: [],
      patterns: [],
      season: undefined,
      environment: undefined,
      description: '',
      tags: [],
    };

    for (const section of sections) {
      const [heading, ...content] = section.split('\n').map((s) => s.trim());
      const sectionContent = content.join(' ').trim();

      if (/SUBJECTS?:/i.test(heading)) {
        result.subjects = sectionContent.split(',').map((s) => s.trim());
      } else if (/COLORS?:/i.test(heading)) {
        result.colors = sectionContent.split(',').map((s) => s.trim());
      } else if (/PATTERNS?:/i.test(heading)) {
        result.patterns = sectionContent.split(',').map((s) => s.trim());
      } else if (/SEASON:/i.test(heading)) {
        result.season = sectionContent;
      } else if (/ENVIRONMENT:/i.test(heading)) {
        result.environment = sectionContent;
      } else if (/TAGS?:/i.test(heading)) {
        result.tags = sectionContent.split(',').map((s) => s.trim());
      } else if (/DESCRIPTION:/i.test(heading)) {
        result.description = sectionContent;
      }
    }

    // Ensure all arrays are populated
    result.subjects = result.subjects.length ? result.subjects : ['Unknown'];
    result.colors = result.colors.length ? result.colors : ['Not specified'];
    result.patterns = result.patterns.length
      ? result.patterns
      : ['None detected'];
    result.tags = result.tags.length ? result.tags : [...result.subjects];
    result.description = result.description || 'No description available';
    result.environment = result.environment || 'Unknown environment';

    return result;
  }
}
