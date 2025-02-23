import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import { config } from 'dotenv';
import express from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import { PhotoIndexer } from '../services/indexer/PhotoIndexer';
import { OpenAIService } from '../services/llm/OpenAIService';
import { ChromaVectorStore } from '../services/vectorstore/VectorStore';
import { AppConfig } from '../types/config';

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
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
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

    const llmService = new OpenAIService(appConfig.llm);
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

    app.post('/api/config', (_req, res) => {
      try {
        // TODO: Validate and save configuration
        // Would typically save to a database or configuration file
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    app.delete('/api/index/clear/:album', async (req, res) => {
      try {
        const { album } = req.params;
        await prisma.photo.deleteMany({
          where: {
            album: {
              equals: album,
            },
          },
        });
        await vectorStore.deleteCollection(album);
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
