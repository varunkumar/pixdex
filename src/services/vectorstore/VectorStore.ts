import { ChromaClient, Collection } from 'chromadb';
import fs from 'fs/promises';
import path from 'path';

export interface VectorStore {
  addDocument(
    id: string,
    vector: number[],
    metadata: Record<string, any>
  ): Promise<void>;
  search(
    queryVector: number[],
    limit?: number
  ): Promise<Array<{ id: string; score: number }>>;
  delete(id: string): Promise<void>;
}

export class ChromaVectorStore implements VectorStore {
  private client: ChromaClient;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.client = new ChromaClient({
      path: 'http://localhost:8000',
    });
  }

  private async retryWithDelay(
    operation: () => Promise<any>,
    attempt: number = 1
  ): Promise<any> {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 5) {
        throw new Error(`Failed after 5 attempts: ${error}`);
      }
      console.log(`Attempt ${attempt} failed, retrying in 2000ms...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return this.retryWithDelay(operation, attempt + 1);
    }
  }

  private async connectToChromaDB(): Promise<ChromaClient> {
    return await this.retryWithDelay(async () => {
      const client = new ChromaClient({
        path: 'http://localhost:8000',
      });

      // Test the connection with a heartbeat
      await client.heartbeat();
      this.client = client;
      return client;
    });
  }

  private async ensureCollection(): Promise<Collection> {
    const client = await this.connectToChromaDB();

    // Get or create the collection
    const collection = await client.getOrCreateCollection({
      name: 'wildlife_photos',
      metadata: {
        description: 'Wildlife photo metadata and embeddings',
      },
    });

    return collection;
  }

  private async ensureDbDirectory(): Promise<string> {
    const fullPath = path.resolve(this.dbPath);
    await fs.mkdir(fullPath, { recursive: true });
    return fullPath;
  }

  private async initialize(): Promise<void> {
    try {
      await this.ensureDbDirectory();
      await this.ensureCollection();
    } catch (error) {
      console.error('Failed to initialize ChromaDB:', error);
      throw error;
    }
  }

  async addDocument(
    id: string,
    vector: number[],
    metadata: Record<string, any>
  ): Promise<void> {
    await this.retryWithDelay(async () => {
      await this.initialize();
      const collection = await this.ensureCollection();

      await collection.add({
        ids: [id],
        embeddings: [vector],
        metadatas: [metadata],
      });
    });
  }

  async search(
    queryVector: number[],
    limit: number = 10
  ): Promise<Array<{ id: string; score: number }>> {
    return await this.retryWithDelay(async () => {
      await this.initialize();
      const collection = await this.ensureCollection();

      const results = await collection.query({
        queryEmbeddings: [queryVector],
        nResults: limit,
      });

      return results.ids[0].map((id, index) => ({
        id,
        score: results.distances?.[0]?.[index] || 0,
      }));
    });
  }

  async delete(id: string): Promise<void> {
    await this.retryWithDelay(async () => {
      await this.initialize();
      const collection = await this.ensureCollection();

      await collection.delete({
        ids: [id],
      });
    });
  }

  async deleteCollection(album: string): Promise<void> {
    await this.retryWithDelay(async () => {
      // Check if the collection exists before trying to delete it
      const collections = await this.client.listCollections();
      const collectionExists = collections.some((collection) => {
        return this.getCollectionName(collection) === album;
      });

      if (collectionExists) {
        await this.client.deleteCollection({ name: album });
      } else {
        console.log(`Collection "${album}" does not exist, skipping deletion`);
      }
    });
  }

  async deleteAllCollections(): Promise<void> {
    await this.retryWithDelay(async () => {
      const collections = await this.client.listCollections();
      for (const collection of collections) {
        const name = this.getCollectionName(collection);
        if (name) {
          await this.client.deleteCollection({ name });
        }
      }
    });
  }

  private getCollectionName(collection: string | { name: string }): string {
    return typeof collection === 'string' ? collection : collection.name;
  }

  // Add a method to delete documents by album
  async deleteDocumentsByAlbum(album: string): Promise<void> {
    await this.retryWithDelay(async () => {
      await this.initialize();
      const collection = await this.ensureCollection();

      // Get all documents in the collection
      const allDocuments = await collection.get();

      // Find IDs of documents that belong to the specified album
      const idsToDelete: string[] = [];

      if (allDocuments.ids && allDocuments.metadatas) {
        allDocuments.ids.forEach((id, index) => {
          const metadata = allDocuments.metadatas?.[index];
          if (metadata && metadata.album === album) {
            idsToDelete.push(id as string);
          }
        });
      }

      // Delete the documents if any are found
      if (idsToDelete.length > 0) {
        console.log(
          `Deleting ${idsToDelete.length} documents for album "${album}"`
        );
        await collection.delete({
          ids: idsToDelete,
        });
      } else {
        console.log(`No documents found for album "${album}"`);
      }
    });
  }
}
