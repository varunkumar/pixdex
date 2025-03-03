import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export interface CachedResult<T> {
  timestamp: number;
  result: T;
}

export class LLMCacheService {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = path.join(cacheDir, 'llm_cache');
    this.ensureCacheDir();
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create cache directory:', error);
    }
  }

  /**
   * Generate a cache key from input parameters
   */
  private generateCacheKey(operationType: string, input: any): string {
    const inputString =
      typeof input === 'string' ? input : JSON.stringify(input);
    return crypto
      .createHash('md5')
      .update(`${operationType}:${inputString}`)
      .digest('hex');
  }

  /**
   * Get the file path for a cache entry
   */
  private getCacheFilePath(cacheKey: string): string {
    return path.join(this.cacheDir, `llm_cache_${cacheKey}.json`);
  }

  /**
   * Check if a cached result exists and is valid
   */
  async getCachedResult<T>(
    operationType: string,
    input: any,
    maxAgeMs: number = 30 * 24 * 60 * 60 * 1000 // 30 days by default
  ): Promise<T | null> {
    try {
      const cacheKey = this.generateCacheKey(operationType, input);
      const cacheFilePath = this.getCacheFilePath(cacheKey);

      // Check if cache file exists
      await fs.access(cacheFilePath);

      // Read and parse cache file
      const cacheData = await fs.readFile(cacheFilePath, 'utf-8');
      const cachedResult = JSON.parse(cacheData) as CachedResult<T>;

      // Check if cache is still valid
      const now = Date.now();
      if (now - cachedResult.timestamp <= maxAgeMs) {
        return cachedResult.result;
      }

      // Cache is expired, delete it
      await fs.unlink(cacheFilePath);
      return null;
    } catch (error) {
      // File doesn't exist or other error
      return null;
    }
  }

  /**
   * Store a result in the cache
   */
  async setCachedResult<T>(
    operationType: string,
    input: any,
    result: T
  ): Promise<void> {
    try {
      // Ensure cache directory exists
      await this.ensureCacheDir();

      const cacheKey = this.generateCacheKey(operationType, input);
      const cacheFilePath = this.getCacheFilePath(cacheKey);

      const cacheData: CachedResult<T> = {
        timestamp: Date.now(),
        result,
      };

      await fs.writeFile(cacheFilePath, JSON.stringify(cacheData), 'utf-8');
    } catch (error) {
      // Log error but don't throw - caching failures shouldn't break the app
      console.error('Failed to cache LLM result:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{ count: number; sizeBytes: number }> {
    try {
      const files = await fs.readdir(this.cacheDir);
      const cacheFiles = files.filter((file) => file.startsWith('llm_cache_'));

      let totalSize = 0;
      for (const file of cacheFiles) {
        const stats = await fs.stat(path.join(this.cacheDir, file));
        totalSize += stats.size;
      }

      return {
        count: cacheFiles.length,
        sizeBytes: totalSize,
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { count: 0, sizeBytes: 0 };
    }
  }

  /**
   * Clear all cached results
   */
  async clearCache(): Promise<void> {
    try {
      // Get all cache files
      const files = await fs.readdir(this.cacheDir);
      const cacheFiles = files.filter((file) => file.startsWith('llm_cache_'));

      // Delete all cache files
      await Promise.all(
        cacheFiles.map((file) => fs.unlink(path.join(this.cacheDir, file)))
      );

      console.log(`Cleared ${cacheFiles.length} LLM cache files`);
    } catch (error) {
      console.error('Failed to clear LLM cache:', error);
      throw error;
    }
  }
}
