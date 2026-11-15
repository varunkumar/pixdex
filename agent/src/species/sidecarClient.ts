import type { AgentConfig } from '../config';
import type { SpeciesDetection } from './decide';

export class SpeciesSidecarClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Whole-frame and per-box candidates for one photo, matched against the species list of `region`. */
  async identify(jpeg: Buffer, region: string): Promise<SpeciesDetection> {
    const response = await this.fetchFn(`${this.baseUrl}/species?region=${encodeURIComponent(region)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: jpeg,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`species sidecar /species failed: ${response.status}`);
    }
    return (await response.json()) as SpeciesDetection;
  }

  /** The model name the sidecar reports; photos scanned with another name are scanned again. */
  async model(): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(`species sidecar /health failed: ${response.status}`);
    }
    return ((await response.json()) as { model: string }).model;
  }
}

/** A sidecar client when SPECIES_SIDECAR_URL is set; undefined (species scanning off) otherwise. */
export function createSpeciesSidecar(config: Pick<AgentConfig, 'SPECIES_SIDECAR_URL'>): SpeciesSidecarClient | undefined {
  return config.SPECIES_SIDECAR_URL ? new SpeciesSidecarClient(config.SPECIES_SIDECAR_URL) : undefined;
}
