import type { AgentConfig } from '../config';

export interface SidecarFace {
  /** Pixel box [x1, y1, x2, y2] in the image that was sent. */
  bbox: [number, number, number, number];
  detScore: number;
  /** Base64 of 512 little-endian float32 values, passed through untouched. */
  embedding: string;
}

export interface SidecarDetection {
  model: string;
  width: number;
  height: number;
  faces: SidecarFace[];
}

export class FaceSidecarClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async detect(jpeg: Buffer): Promise<SidecarDetection> {
    const response = await this.fetchFn(`${this.baseUrl}/faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: jpeg,
    });
    if (!response.ok) {
      throw new Error(`sidecar /faces failed: ${response.status}`);
    }
    return (await response.json()) as SidecarDetection;
  }

  /** The model name the sidecar reports, used to find photos not yet scanned with it. */
  async model(): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`sidecar /health failed: ${response.status}`);
    }
    return ((await response.json()) as { model: string }).model;
  }
}

/** A sidecar client when FACE_SIDECAR_URL is set; undefined (face scanning off) otherwise. */
export function createFaceSidecar(config: Pick<AgentConfig, 'FACE_SIDECAR_URL'>): FaceSidecarClient | undefined {
  return config.FACE_SIDECAR_URL ? new FaceSidecarClient(config.FACE_SIDECAR_URL) : undefined;
}
