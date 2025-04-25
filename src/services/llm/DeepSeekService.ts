import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { LLMConfig } from '../../types/config';
import { PhotoMetadata } from '../../types/photo';
import { LLMCacheService } from './LLMCacheService';
import { ImageAnalysisResult, LLMService } from './LLMService';

export class DeepSeekService implements LLMService {
  private readonly SUPPORTED_FORMATS = ['jpeg', 'jpg', 'png', 'webp'];
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly MAX_DIMENSION = 1024;
  private readonly MIN_DIMENSION = 224;
  private modelPath: string;
  private cacheEnabled = true;

  constructor(
    private config: LLMConfig,
    private cacheService?: LLMCacheService
  ) {
    // Default model path - use DeepSeek's vision-language model
    this.modelPath =
      this.config.modelName || 'deepseek-ai/deepseek-vl-1.3b-chat';

    // Initialize cache if directory is provided
    if (cacheService) {
      this.cacheService = cacheService;
    }
    this.validatePythonDependency();
  }

  private async validatePythonDependency(): Promise<void> {
    try {
      const pythonCheck = spawn('python3', ['--version']);

      return new Promise((resolve, reject) => {
        pythonCheck.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            console.error(
              '\x1b[31mError: Python is required for DeepSeek but not found in PATH\x1b[0m'
            );
            console.error(
              '\x1b[33mPlease install Python and ensure it is available in your system PATH.\x1b[0m'
            );
            console.error(
              '\x1b[33mYou can download Python from: https://www.python.org/downloads/\x1b[0m'
            );
            reject(new Error('Python dependency not found'));
          } else {
            reject(err);
          }
        });

        pythonCheck.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Python check failed with code ${code}`));
          }
        });
      });
    } catch (error) {
      console.error('\x1b[31mError checking Python dependency:\x1b[0m', error);
      throw error;
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

  private debugLog(message: string, metadata?: Record<string, unknown>) {
    if (process.env.DEBUG) {
      const timestamp = new Date().toISOString();
      console.info(`[DeepSeek] ${timestamp} - ${message}`);
      if (metadata) {
        console.debug(JSON.stringify(metadata, null, 2));
      }
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

      return processedPath;
    } catch (error) {
      // Clean up any temporary files
      await fs.unlink(processedPath).catch(() => {});
      throw error;
    }
  }

  private async runLocalInference(
    imagePath: string,
    prompt: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, 'deepseek_inference.py');
      const pythonProcess = spawn('python3', [
        scriptPath,
        imagePath,
        this.modelPath,
      ]);

      let dataBuffer = '';
      let errorBuffer = '';

      pythonProcess.stdout.on('data', (data) => {
        dataBuffer += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        errorBuffer += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          this.debugLog(`Python process exited with code ${code}`);
          this.debugLog(`Error: ${errorBuffer}`);
          reject(new Error(`Failed to run inference: ${errorBuffer}`));
        } else {
          // Extract the model output (skip any debug/info messages)
          const lines = dataBuffer.split('\n');
          const resultLines = lines.filter(
            (line) =>
              !line.startsWith('Using device:') && !line.startsWith('Loading')
          );
          resolve(resultLines.join('\n'));
        }
      });
    });
  }

  async analyzeImage(imagePath: string): Promise<ImageAnalysisResult> {
    // Generate a cache key based on file stats and path for image analysis
    let cacheKey = `${imagePath}`;

    // Check cache first if it's enabled and available
    if (this.cacheEnabled && this.cacheService) {
      try {
        // Use file stats to make a more accurate cache key
        const fileStats = await fs.stat(imagePath);
        cacheKey = `${imagePath}_${fileStats.size}_${fileStats.mtimeMs}`;
        const cachedResult =
          await this.cacheService.getCachedResult<ImageAnalysisResult>(
            'analyzeImage',
            cacheKey
          );
        if (cachedResult) {
          this.debugLog('Using cached image analysis result');
          return cachedResult;
        }
      } catch (error) {
        // Continue if cache lookup fails
        this.debugLog('Cache lookup failed, proceeding with analysis');
      }
    }

    let processedImagePath: string | null = null;
    try {
      processedImagePath = await this.preprocessImage(imagePath);

      // Prompt for DeepSeek VL model
      const prompt = `Analyze this wildlife photo and provide the following information in a structured format:
      1. SUBJECTS: List all animals/wildlife subjects visible in the image
      2. COLORS: List dominant colors in the image
      3. PATTERNS: Describe any notable patterns or textures
      4. SEASON: If apparent from the environment or context. Indian seasons.
      5. ENVIRONMENT: Detailed description of the habitat/setting
      6. TAGS: Relevant keywords for searching (max 10)
      7. DESCRIPTION: A detailed, professional description of the photo
      Format each section clearly with headings.`;

      // Run inference using the local model
      this.debugLog('Running local DeepSeek inference...');
      const content = await this.runLocalInference(processedImagePath, prompt);

      this.debugLog('Received response from local DeepSeek model');
      if (!content) throw new Error('No analysis received from DeepSeek model');

      const result = this.parseAnalysisResponse(content);

      // Cache the result if caching is enabled
      if (this.cacheEnabled && this.cacheService) {
        await this.cacheService.setCachedResult(
          'analyzeImage',
          cacheKey,
          result
        );
      }

      return result;
    } catch (error) {
      console.error('Error in DeepSeek image analysis:', error);
      throw error;
    } finally {
      // Clean up processed image
      if (processedImagePath) {
        await fs.unlink(processedImagePath).catch(() => {});
      }
    }
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

    const prompt = `Generate an engaging Instagram caption for this wildlife photo using these details:
    Subject: ${photo.aiMetadata.subjects.join(', ')}
    Environment: ${photo.aiMetadata.environment}
    Description: ${photo.aiMetadata.description}
    Season: ${photo.aiMetadata.season || 'Not specified'}
    Make it:
    1. Engaging and informative
    2. Include interesting facts about the subject
    3. End with a thought-provoking question
    4. Keep it under 200 characters`;

    // For text-only tasks, we'll use a lighter approach
    const caption = await this.runLocalTextGeneration(prompt);

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

    const prompt = `Generate relevant Instagram hashtags for this wildlife photo:
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
    7. Return as simple comma-separated list without # symbol`;

    // For text-only tasks, we'll use a lighter approach
    const content = await this.runLocalTextGeneration(prompt);

    const hashtags = content
      .split(/[,\n]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
      .map((tag) => tag.replace(/[^a-zA-Z0-9_]/g, ''))
      .filter((tag) => tag.length > 0 && tag.length <= 30); // Instagram hashtag length limit

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

    // Use a local embedding model
    const embedding = await this.runLocalEmbeddingGeneration(text);

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

  private async runLocalTextGeneration(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use Python to run local text generation
      const pythonProcess = spawn('python', [
        '-c',
        `
import sys
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

try:
    # Use a lightweight model for text generation
    model_name = "deepseek-ai/deepseek-coder-1.3b-instruct" # Can be configured from config.modelName
    
    # Load tokenizer and model
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(
        model_name, 
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        low_cpu_mem_usage=True
    )
    
    # Move model to device
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = model.to(device)
    
    # Create input
    prompt = """${prompt.replace(/'/g, "\\'").replace(/"/g, '\\"')}"""
    inputs = tokenizer(prompt, return_tensors="pt").to(device)
    
    # Generate
    with torch.no_grad():
        output = model.generate(**inputs, max_new_tokens=200, do_sample=True, temperature=0.7)
        
    # Get result
    result = tokenizer.decode(output[0], skip_special_tokens=True)
    
    # Return only the generated text after the prompt
    response = result[len(prompt):].strip()
    print(response)
    
except Exception as e:
    print(f"Error: {str(e)}", file=sys.stderr)
    sys.exit(1)
        `,
      ]);

      let dataBuffer = '';
      let errorBuffer = '';

      pythonProcess.stdout.on('data', (data) => {
        dataBuffer += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        errorBuffer += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to run text generation: ${errorBuffer}`));
        } else {
          resolve(dataBuffer.trim());
        }
      });
    });
  }

  private async runLocalEmbeddingGeneration(text: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const pythonProcess = spawn('python', [
        '-c',
        `
import sys
import torch
from transformers import AutoModel, AutoTokenizer

try:
    # Use a lightweight embedding model
    model_name = "sentence-transformers/all-MiniLM-L6-v2"
    
    # Load tokenizer and model
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name)
    
    # Create input
    text = """${text.replace(/'/g, "\\'").replace(/"/g, '\\"')}"""
    inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True)
    
    # Generate embedding
    with torch.no_grad():
        outputs = model(**inputs)
        embeddings = outputs.last_hidden_state.mean(dim=1)
        
    # Convert to list
    embedding_list = embeddings[0].tolist()
    
    # Print as JSON
    import json
    print(json.dumps(embedding_list))
    
except Exception as e:
    print(f"Error: {str(e)}", file=sys.stderr)
    sys.exit(1)
        `,
      ]);

      let dataBuffer = '';
      let errorBuffer = '';

      pythonProcess.stdout.on('data', (data) => {
        dataBuffer += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        errorBuffer += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to generate embedding: ${errorBuffer}`));
        } else {
          try {
            const embedding = JSON.parse(dataBuffer.trim());
            resolve(embedding);
          } catch (err) {
            const error = err as Error;
            reject(new Error(`Failed to parse embedding: ${error.message}`));
          }
        }
      });
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
