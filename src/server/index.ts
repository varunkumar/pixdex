import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import { config } from 'dotenv';
import express from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'path';
import { PhotoIndexer } from '../services/indexer/PhotoIndexer';
import { DeepSeekService } from '../services/llm/DeepSeekService';
import { Grok3Service } from '../services/llm/Grok3Service';
import { LLMCacheService } from '../services/llm/LLMCacheService';
import { LLMService } from '../services/llm/LLMService';
import { OpenAIService } from '../services/llm/OpenAIService';
import { ChromaVectorStore } from '../services/vectorstore/VectorStore';
import { AppConfig, LLMConfig } from '../types/config';

config(); // Load environment variables

const app = express();
const port = process.env.PORT || 3001;

const prisma = new PrismaClient();

// Ensure required directories exist
async function ensureDirectories() {
  const dirs = [
    process.env.PHOTOS_CACHE_DIR || './data/cache',
    process.env.CHROMA_DB_PATH || './data/chromadb',
    './credentials',
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Check if ChromaDB is running
async function checkChromaDBConnection() {
  try {
    const response = await fetch('http://localhost:8000/api/v1/heartbeat');
    if (!response.ok) throw new Error('ChromaDB heartbeat failed');
    console.log('ChromaDB connection successful');
    return true;
  } catch (error) {
    console.error('ChromaDB not running:', error);
    console.log('Please start ChromaDB using: npm run chroma');
    return false;
  }
}

interface PhotoStats {
  totalPhotos: number;
  uniqueSubjects: number;
  uniqueLocations: number;
  uniqueAlbums: number;
}

async function getPhotoStats(): Promise<PhotoStats> {
  const photos = await prisma.photo.findMany();

  const uniqueSubjects = new Set<string>();
  const uniqueLocations = new Set<string>();
  const uniqueAlbums = new Set<string>();

  photos.forEach((photo) => {
    const subjects = JSON.parse(photo.subjectsJson) as string[];
    subjects.forEach((subject) => uniqueSubjects.add(subject));

    if (photo.locationPlace) {
      uniqueLocations.add(photo.locationPlace);
    }

    if (photo.album) {
      uniqueAlbums.add(photo.album);
    }
  });

  return {
    totalPhotos: photos.length,
    uniqueSubjects: uniqueSubjects.size,
    uniqueLocations: uniqueLocations.size,
    uniqueAlbums: uniqueAlbums.size,
  };
}

function createLLMService(config: LLMConfig, cacheDir: string): LLMService {
  // Create cache service instance
  const cacheService = new LLMCacheService(cacheDir);

  // Create appropriate service based on configured provider
  switch (config.provider) {
    case 'openai':
      return new OpenAIService(config, cacheService);
    case 'grok3':
      return new Grok3Service(config, cacheService);
    case 'deepseek':
      return new DeepSeekService(config, cacheService);
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

// Initialize application
async function initializeApp() {
  try {
    await ensureDirectories();

    // Check ChromaDB connection
    const isChromaRunning = await checkChromaDBConnection();
    if (!isChromaRunning) {
      throw new Error(
        'ChromaDB is not running. Please start it using: npm run chroma'
      );
    }

    // Configure multer for file uploads
    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, process.env.PHOTOS_CACHE_DIR || './data/cache');
      },
      filename: (_req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
      },
    });

    const upload = multer({ storage });

    // Middleware
    app.use(cors());
    app.use(express.json());

    // Initialize services
    const appConfig: AppConfig = {
      llm: {
        provider:
          (process.env.LLM_PROVIDER as 'openai' | 'grok3' | 'deepseek') ||
          'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
        modelName: process.env.LLM_MODEL_NAME,
        temperature: process.env.LLM_TEMPERATURE
          ? parseFloat(process.env.LLM_TEMPERATURE)
          : undefined,
      },
      storage: {
        localPaths: (process.env.LOCAL_PHOTO_PATHS || '')
          .split(',')
          .filter(Boolean),
        googleDrive: {
          enabled: process.env.ENABLE_GOOGLE_DRIVE === 'true',
          credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
        },
      },
      chromaDbPath: process.env.CHROMA_DB_PATH || './data/chromadb',
      cacheDir: process.env.PHOTOS_CACHE_DIR || './data/cache',
    };

    // Setup LLM cache in its own directory
    const llmCacheDir = path.join(appConfig.cacheDir, 'llm_cache');
    await fs.mkdir(llmCacheDir, { recursive: true });

    // Create LLM service with caching
    const llmService = createLLMService(appConfig.llm, llmCacheDir);

    const vectorStore = new ChromaVectorStore(appConfig.chromaDbPath);
    const photoIndexer = new PhotoIndexer(
      llmService,
      vectorStore,
      appConfig.storage
    );

    // SSE endpoint for progress updates
    app.get('/api/index/progress', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const sendProgress = (progress: any) => {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      };

      photoIndexer.progressEmitter.on('progress', sendProgress);

      // Remove listener when client disconnects
      req.on('close', () => {
        photoIndexer.progressEmitter.removeListener('progress', sendProgress);
      });
    });

    // API Routes
    app.post('/api/index/local', async (_req, res) => {
      try {
        const photos = await photoIndexer.indexLocalPhotos();
        res.json(photos);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    app.post('/api/index/drive', async (_req, res) => {
      try {
        const photos = await photoIndexer.indexGoogleDrivePhotos();
        res.json(photos);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    app.post(
      '/api/photos/analyze',
      upload.single('photo'),
      async (req, res) => {
        try {
          if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
          }
          const photo = await photoIndexer.analyzePhoto(req.file.path);
          res.json(photo);
        } catch (error) {
          res.status(500).json({ error: (error as Error).message });
        }
      }
    );

    app.post('/api/photos/search', async (req, res) => {
      try {
        const criteria = req.body;
        const results = await photoIndexer.search(criteria);
        res.json(results);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    app.get('/api/photos/daily', async (_req, res) => {
      try {
        const suggestion = await photoIndexer.getDailySuggestion();
        res.json(suggestion);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    app.get('/api/photos/stats', async (_req, res) => {
      try {
        const stats = await getPhotoStats();
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    app.get('/api/albums', async (_req, res) => {
      try {
        const photos = await prisma.photo.findMany({
          where: {
            NOT: {
              album: {
                equals: null,
              },
            },
          },
        });

        const albums = [
          ...new Set(
            photos
              .filter(
                (p): p is typeof p & { album: string } => p.album !== null
              )
              .map((p) => p.album)
          ),
        ];
        res.json(albums);
      } catch (error) {
        console.error('Error fetching albums:', error);
        res.status(500).json({ error: 'Failed to fetch albums' });
      }
    });

    app.get('/api/config', (_req, res) => {
      // Remove sensitive information
      const safeConfig = {
        ...appConfig,
        llm: {
          ...appConfig.llm,
          apiKey: undefined,
        },
      };
      res.json(safeConfig);
    });

    app.post('/api/config', async (req, res) => {
      try {
        const newConfig = req.body as AppConfig;

        // Validate new configuration
        if (
          !newConfig.llm?.provider ||
          !newConfig.storage ||
          !newConfig.chromaDbPath ||
          !newConfig.cacheDir
        ) {
          return res
            .status(400)
            .json({ error: 'Invalid configuration format' });
        }

        // Update environment variables with new configuration
        process.env.LLM_PROVIDER = newConfig.llm.provider;
        process.env.OPENAI_API_KEY = newConfig.llm.apiKey;
        process.env.LLM_MODEL_NAME = newConfig.llm.modelName;
        process.env.LLM_TEMPERATURE = newConfig.llm.temperature?.toString();
        process.env.LOCAL_PHOTO_PATHS = newConfig.storage.localPaths.join(',');
        process.env.ENABLE_GOOGLE_DRIVE =
          newConfig.storage.googleDrive.enabled.toString();
        process.env.GOOGLE_APPLICATION_CREDENTIALS =
          newConfig.storage.googleDrive.credentialsPath;
        process.env.CHROMA_DB_PATH = newConfig.chromaDbPath;
        process.env.PHOTOS_CACHE_DIR = newConfig.cacheDir;

        // Create new LLM service if provider changed
        if (newConfig.llm.provider !== appConfig.llm.provider) {
          const newLLMService = createLLMService(newConfig.llm, llmCacheDir);
          // Update the photoIndexer with the new LLM service
          photoIndexer.updateLLMService(newLLMService);
        } else if (
          newConfig.llm.apiKey !== appConfig.llm.apiKey ||
          newConfig.llm.modelName !== appConfig.llm.modelName ||
          newConfig.llm.temperature !== appConfig.llm.temperature
        ) {
          // If other LLM settings changed but not the provider
          const newLLMService = createLLMService(newConfig.llm, llmCacheDir);
          photoIndexer.updateLLMService(newLLMService);
        }

        // Update vector store if path changed
        if (newConfig.chromaDbPath !== appConfig.chromaDbPath) {
          const newVectorStore = new ChromaVectorStore(newConfig.chromaDbPath);
          photoIndexer.updateVectorStore(newVectorStore);
        }

        // Update the global config
        Object.assign(appConfig, newConfig);

        res.json({ success: true, config: appConfig });
      } catch (error) {
        console.error('Error updating configuration:', error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    app.delete('/api/index/clear/:album', async (req, res) => {
      try {
        const { album } = req.params;
        // First, delete photos from the database
        await prisma.photo.deleteMany({
          where: {
            album: {
              equals: album,
            },
          },
        });

        // Then, delete documents from the vector store
        await vectorStore.deleteDocumentsByAlbum(album);

        res.json({ success: true });
      } catch (error) {
        console.error('Error clearing album index:', error);
        res.status(500).json({ error: 'Failed to clear album index' });
      }
    });

    app.delete('/api/index/clear-all', async (_req, res) => {
      try {
        await prisma.photo.deleteMany();
        await vectorStore.deleteAllCollections();
        res.json({ success: true });
      } catch (error) {
        console.error('Error clearing all indices:', error);
        res.status(500).json({ error: 'Failed to clear all indices' });
      }
    });

    // Add endpoint to clear the LLM cache
    app.delete('/api/cache/clear', async (_req, res) => {
      try {
        if (
          'clearCache' in llmService &&
          typeof llmService.clearCache === 'function'
        ) {
          await llmService.clearCache();
          res.json({
            success: true,
            message: 'LLM cache cleared successfully',
          });
        } else {
          res.status(400).json({
            error: 'Current LLM service does not support cache clearing',
          });
        }
      } catch (error) {
        console.error('Error clearing LLM cache:', error);
        res.status(500).json({ error: 'Failed to clear LLM cache' });
      }
    });

    // Add endpoint to toggle cache usage
    app.post('/api/cache/toggle', async (req, res) => {
      try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res
            .status(400)
            .json({ error: 'Missing or invalid "enabled" parameter' });
        }

        llmService.enableCache(enabled);
        res.json({ success: true, cacheEnabled: enabled });
      } catch (error) {
        console.error('Error toggling cache:', error);
        res.status(500).json({ error: 'Failed to toggle cache' });
      }
    });

    // Start server
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Start the application
initializeApp();
