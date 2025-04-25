# PixDex

A photo indexing and search application using AI for image analysis.

## Features

- Index photos from local directories and Google Drive
- AI-powered image analysis for content, subjects, and context
- Search photos by text queries, subjects, and semantic similarity
- Generate captions and hashtags for social media sharing

## Prerequisites

- Node.js 18+
- Mac Studio (or similar macOS system)
- OpenAI API key or other LLM API credentials
- Google Cloud credentials (for Google Drive integration)
- Docker (for ChromaDB)

## API Keys & Credentials Setup

### OpenAI API Key

1. Visit [OpenAI API](https://platform.openai.com/signup)
2. Create an account or sign in
3. Go to API Keys section in your dashboard
4. Click "Create new secret key"
5. Copy the key (you won't be able to see it again)
6. Add it to your .env file as `OPENAI_API_KEY`

Note: This application uses GPT-4 Vision API which requires:

- An OpenAI account with GPT-4 API access enabled
- Sufficient API credits
- Maximum image size: 20MB per image
- Supported formats: PNG, JPEG, WEBP, GIF (first frame only)
- Recommended resolution: 512x512 to 2048x2048 pixels

### Google Cloud Credentials (for Drive API)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Enable the Google Drive API:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Drive API"
   - Click "Enable"
4. Create service account credentials:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service Account"
   - Fill in service account details
   - Skip role assignment (or assign Viewer role)
   - Click "Done"
5. Create and download credentials:
   - Find your service account in the list
   - Click on it and go to "Keys" tab
   - Click "Add Key" > "Create New Key"
   - Choose JSON format
   - Download the JSON file
6. Move the downloaded file to your project:
   ```bash
   mv ~/Downloads/your-credentials.json ./credentials/google-drive.json
   ```
7. Update your .env file:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=./credentials/google-drive.json
   ENABLE_GOOGLE_DRIVE=true
   ```

## Setup

1. Install Docker:

   - Visit [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
   - Download and install Docker Desktop
   - Start Docker Desktop and ensure it's running

2. Install dependencies:

```bash
npm install
```

3. Configure environment variables:
   Create a .env file in the root directory with the values from .env.example:

```
OPENAI_API_KEY=your_openai_key
GOOGLE_APPLICATION_CREDENTIALS=path_to_credentials.json
CHROMA_DB_PATH=./data/chromadb
PHOTOS_CACHE_DIR=./data/cache
PORT=3001
LOCAL_PHOTO_PATHS=/path/to/photos/dir1,/path/to/photos/dir2
ENABLE_GOOGLE_DRIVE=false
```

4. Start ChromaDB (in a separate terminal):

```bash
npm run chroma
```

This will start ChromaDB in a Docker container with persistent storage in the ./data/chromadb directory.

5. Start the development server:

```bash
npm run dev
```

6. Start the backend service (in a separate terminal):

```bash
npm run server
```

## Directory Structure

Create the following directories before running the application:

```
data/
  cache/      # Temporary storage for image processing
  chromadb/   # Vector database storage
credentials/  # Store your Google Drive credentials here
```

You can create these directories using:

```bash
mkdir -p data/cache data/chromadb credentials
```

## Project Structure

- `/src/components` - React UI components
- `/src/services` - Backend services and API integration
- `/src/indexer` - Photo indexing and metadata extraction
- `/src/types` - TypeScript type definitions
- `/src/utils` - Utility functions
- `/src/hooks` - Custom React hooks
- `/server` - Express.js backend server

## LLM Configuration

The application supports multiple LLM backends. Configure your preferred LLM in `/src/config/llm.ts`.

Supported LLMs:

- OpenAI GPT-4 Vision
- Grok3
- DeepSeek AI
- (Add more by implementing the LLMProvider interface)

## Local DeepSeek Model Setup

To use the local DeepSeek image analysis model:

1. Install Python dependencies:

```bash
pip install torch torchvision transformers pillow
```

2. Update your application configuration:

```json
{
  "llm": {
    "provider": "deepseek",
    "modelName": "deepseek-ai/deepseek-vl-7b-chat",
    "temperature": 0.7
  }
}
```

Available DeepSeek vision-language models:

- `deepseek-ai/deepseek-vl-7b-chat` - Recommended balance of quality and performance
- `deepseek-ai/deepseek-vl-1.3b-chat` - Lightweight model for systems with limited resources
- `deepseek-ai/janus-pro-35b-chat-complete` - High quality but requires significantly more GPU memory

For text generation and embeddings, lightweight models are used automatically:

- Text generation: `deepseek-ai/deepseek-coder-1.3b-instruct`
- Embeddings: `sentence-transformers/all-MiniLM-L6-v2`

### Hardware Requirements

- CPU-only: Will work but be slow for image analysis
- GPU: CUDA-compatible GPU with at least 8GB VRAM recommended (16GB+ for larger models)
- Memory: At least 8GB RAM (16GB+ recommended)

## Getting Started

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

3. Set up environment variables:

```
OPENAI_API_KEY=your_openai_api_key
LOCAL_PHOTO_PATHS=/path/to/photos,/another/path
CHROMA_DB_PATH=./data/chromadb
PHOTOS_CACHE_DIR=./data/cache
PORT=3001
```

4. Start ChromaDB:

```bash
npm run chroma:up
```

5. Start the server:

```bash
npm run server
```

6. Start the frontend:

```bash
npm run dev
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Submit a pull request

## License

MIT
