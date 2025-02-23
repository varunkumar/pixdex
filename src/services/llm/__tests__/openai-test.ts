import dotenv from 'dotenv';
import fs from 'fs/promises';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { LLMConfig } from '../../../types/config';
import { OpenAIService } from '../OpenAIService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../../../');

// Load environment variables from .env file
dotenv.config({ path: path.resolve(projectRoot, '.env') });

async function testOpenAI() {
  // Validate required environment variables
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not found in .env file');
  }

  const cacheDir = process.env.PHOTOS_CACHE_DIR || path.join(projectRoot, 'data/cache');
  console.log('Cache directory:', cacheDir);

  // Create OpenAI service instance
  const config: LLMConfig = {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
  };

  const openAIService = new OpenAIService(config);

  try {
    // Test with a single image
    const testImagePath = path.join(cacheDir, 'test-image.jpg');
    console.log('Test image path:', testImagePath);

    // Check if test image exists
    try {
      await fs.access(testImagePath);
      console.log('Found test image');
    } catch (error) {
      throw new Error(
        `Test image not found at ${testImagePath}. Please ensure a test-image.jpg exists in your cache directory.`
      );
    }

    console.log('Starting image analysis...');
    const result = await openAIService.analyzeImage(testImagePath);
    console.log('Analysis result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error during analysis:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run the test
console.log('Running OpenAI Vision API test...');
testOpenAI().catch((error) => {
  console.error('Test failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
