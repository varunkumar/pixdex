import type { AgentConfig } from './config';
import type { CameraExif } from './exif';

const CHECK_HASHES_BATCH_SIZE = 500;

export interface FacePayload {
  bbox: { x: number; y: number; w: number; h: number };
  detScore: number;
  embedding: string;
}

export interface IngestPhotoPayload {
  id: string;
  contentHash: string;
  source: 'local' | 'google_drive';
  path?: string;
  driveFileId?: string;
  filename: string;
  dateTime?: string;
  width?: number;
  height?: number;
  format?: string;
  fileSize?: number;
  subjects: string[];
  colors: string[];
  patterns: string[];
  tags: string[];
  season?: string;
  environment?: string;
  album?: string;
  description: string;
  suggestedCaption: string;
  suggestedHashtags: string[];
  modelProvider: string;
  modelName: string;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  focalLength?: number;
  fNumber?: number;
  exposureTime?: number;
  iso?: number;
  latitude?: number;
  longitude?: number;
  hasWatermark?: boolean;
  /** 1-10 rating of how good the photo looks; omitted when the model gave none. */
  aestheticScore?: number;
  /** 3-4 word title; omitted when the model gave none. */
  shortCaption?: string;
}

export class CloudflareClient {
  constructor(
    private config: AgentConfig,
    private fetchFn: typeof fetch = fetch
  ) {}

  private authHeaders(contentType: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.INGEST_TOKEN}`,
      'Content-Type': contentType,
    };
  }

  async checkHashes(hashes: string[]): Promise<Set<string>> {
    const known = new Set<string>();

    for (let i = 0; i < hashes.length; i += CHECK_HASHES_BATCH_SIZE) {
      const batch = hashes.slice(i, i + CHECK_HASHES_BATCH_SIZE);
      const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/check-hashes`, {
        method: 'POST',
        headers: this.authHeaders('application/json'),
        body: JSON.stringify({ hashes: batch }),
      });
      if (!response.ok) {
        throw new Error(`check-hashes failed: ${response.status}`);
      }
      const body = (await response.clone().json()) as { known: string[] };
      body.known.forEach((h) => known.add(h));
    }

    return known;
  }

  /** Hashes that are indexed but not yet face-scanned with this model. */
  async facesPending(hashes: string[], model: string): Promise<Set<string>> {
    const pending = new Set<string>();

    for (let i = 0; i < hashes.length; i += CHECK_HASHES_BATCH_SIZE) {
      const batch = hashes.slice(i, i + CHECK_HASHES_BATCH_SIZE);
      const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/faces/pending`, {
        method: 'POST',
        headers: this.authHeaders('application/json'),
        body: JSON.stringify({ hashes: batch, model }),
      });
      if (!response.ok) {
        throw new Error(`ingest/faces/pending failed: ${response.status}`);
      }
      const body = (await response.clone().json()) as { pending: string[] };
      body.pending.forEach((h) => pending.add(h));
    }

    return pending;
  }

  /** One page of indexed local photos not yet face-scanned with this model (content hash and source path). */
  async facesUnscanned(
    model: string,
    opts: { cursor?: number; pathPrefix?: string; limit?: number; missingCrops?: boolean } = {}
  ): Promise<{ items: { contentHash: string; path: string }[]; nextCursor: number | null }> {
    const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/faces/unscanned`, {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify({ model, ...opts }),
    });
    if (!response.ok) {
      throw new Error(`ingest/faces/unscanned failed: ${response.status}`);
    }
    return (await response.json()) as { items: { contentHash: string; path: string }[]; nextCursor: number | null };
  }

  /**
   * Replaces a photo's detected faces (an empty list marks it scanned). Returns the id each posted
   * face was stored under (a kept confirmed face keeps its own id), or null if the hash is unknown.
   */
  async ingestFaces(contentHash: string, model: string, faces: FacePayload[]): Promise<{ faceIds: string[] } | null> {
    const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/faces`, {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify({ contentHash, model, faces }),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`ingest/faces failed: ${response.status}`);
    }
    const body = (await response.json()) as { faceIds?: string[] };
    return { faceIds: body.faceIds ?? [] };
  }

  /** Uploads the sharp crop (JPEG bytes) of one stored face. */
  async putFaceCrop(faceId: string, jpeg: Buffer): Promise<void> {
    const response = await this.fetchFn(
      `${this.config.CLOUDFLARE_API_BASE_URL}/ingest/faces/${encodeURIComponent(faceId)}/crop`,
      { method: 'PUT', headers: this.authHeaders('image/jpeg'), body: jpeg }
    );
    if (!response.ok) {
      throw new Error(`ingest/faces/crop failed: ${response.status}`);
    }
  }

  async ingestPhoto(payload: IngestPhotoPayload): Promise<void> {
    const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/photo`, {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`ingest/photo failed: ${response.status}`);
    }
  }

  /** Sets camera/EXIF columns on an already-indexed photo; false if the hash is unknown. */
  async updateExif(contentHash: string, camera: CameraExif): Promise<boolean> {
    const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/exif`, {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify({ contentHash, ...camera }),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`ingest/exif failed: ${response.status}`);
    }
    return true;
  }

  /** Re-points indexed local photos from folder `from` to `to`; with `dryRun` it only counts them. */
  async relocatePhotos(from: string, to: string, dryRun = false): Promise<{ matched: number; updated: number }> {
    const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/relocate`, {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify({ from, to, dryRun }),
    });
    if (!response.ok) {
      throw new Error(`ingest/relocate failed: ${response.status}`);
    }
    return (await response.json()) as { matched: number; updated: number };
  }

  /** Sets the aesthetic score and/or short caption on an already-indexed photo; false if the hash is unknown. */
  async updateRating(contentHash: string, rating: { score?: number; shortCaption?: string }): Promise<boolean> {
    const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/rating`, {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify({ contentHash, ...rating }),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`ingest/rating failed: ${response.status}`);
    }
    return true;
  }

  async uploadThumbnail(contentHash: string, bytes: Buffer): Promise<void> {
    const response = await this.fetchFn(
      `${this.config.CLOUDFLARE_API_BASE_URL}/ingest/thumbnail/${contentHash}`,
      {
        method: 'PUT',
        headers: this.authHeaders('image/jpeg'),
        body: bytes,
      }
    );
    if (!response.ok) {
      throw new Error(`ingest/thumbnail failed: ${response.status}`);
    }
  }
}
