import type { AgentConfig } from './config';

const CHECK_HASHES_BATCH_SIZE = 500;

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
