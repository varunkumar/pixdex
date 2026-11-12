const USER_AGENT = 'face-gallery-builder/0.1';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const DEFAULT_DELAY_MS = 1_500;
export const MAX_DELAY_MS = 8_000;
export const MAX_ATTEMPTS = 6;
const MAX_RETRY_AFTER_MS = 120_000;
const BACKOFF_START_MS = 5_000;
const DECAY_AFTER_SUCCESSES = 20;
const RASTER = /\.(jpe?g|png|webp)$/i;

/** Wikimedia kept answering 429/503 after every retry: the person is failed (retried next run), never excluded. */
export class RateLimitedError extends Error {
  constructor(status: number) {
    super(`Wikimedia rate limited the request (HTTP ${status}) after ${MAX_ATTEMPTS} attempts`);
    this.name = 'RateLimitedError';
  }
}

/** Only raster photos can hold a usable face; audio, video, svg, pdf and tiff files are never crawled. */
export function isRasterTitle(title: string): boolean {
  return RASTER.test(title);
}

/** Retry-After as milliseconds: delta seconds or an HTTP date; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

export interface WikimediaOptions {
  /** Base minimum delay between requests. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 0..1, for backoff jitter. */
  random?: () => number;
  /** Called once per rate-limit wait, with the wait in seconds. */
  onRateLimit?: (seconds: number) => void;
}

interface ClaimsResponse {
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>;
}

/**
 * Read-only client for Wikidata and Wikimedia Commons. Polite by construction: a generic User-Agent, a minimum
 * delay between requests that doubles after a 429 (up to 8 s) and halves after every 20 successes, and
 * Retry-After (or exponential backoff) on 429/503 for up to 6 attempts, then RateLimitedError.
 */
export class WikimediaClient {
  private lastRequestAt = 0;
  private currentDelay: number;
  private successes = 0;
  private readonly baseDelay: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  onRateLimit?: (seconds: number) => void;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    opts: WikimediaOptions = {}
  ) {
    this.baseDelay = opts.delayMs ?? DEFAULT_DELAY_MS;
    this.currentDelay = this.baseDelay;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.onRateLimit = opts.onRateLimit;
  }

  /** The current minimum delay between requests (for tests and progress output). */
  get paceMs(): number {
    return this.currentDelay;
  }

  private async request(url: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastRequestAt + this.currentDelay - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      const response = await this.fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 429 && response.status !== 503) {
        if (response.ok && ++this.successes >= DECAY_AFTER_SUCCESSES) {
          this.successes = 0;
          this.currentDelay = Math.max(this.baseDelay, Math.floor(this.currentDelay / 2));
        }
        return response;
      }
      this.successes = 0;
      this.currentDelay = Math.min(MAX_DELAY_MS, Math.max(this.currentDelay, this.baseDelay) * 2);
      if (attempt >= MAX_ATTEMPTS) throw new RateLimitedError(response.status);
      const fromHeader = parseRetryAfter(response.headers.get('Retry-After'), this.now());
      const backoff = BACKOFF_START_MS * 2 ** (attempt - 1) * (1 + this.random() * 0.25);
      const waitMs = Math.min(MAX_RETRY_AFTER_MS, fromHeader ?? backoff);
      this.onRateLimit?.(Math.ceil(waitMs / 1000));
      await this.sleep(waitMs);
    }
  }

  private async getJson<T>(base: string, params: Record<string, string>): Promise<T> {
    const url = `${base}?${new URLSearchParams({ format: 'json', ...params }).toString()}`;
    const response = await this.request(url);
    if (!response.ok) throw new Error(`Wikimedia request failed: ${response.status}`);
    return (await response.json()) as T;
  }

  /** Downloads an image with the same pacing and Retry-After handling; a persistent 429 throws RateLimitedError. */
  async download(url: string): Promise<Buffer> {
    const response = await this.request(url);
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async claimValue(qid: string, property: string): Promise<string | undefined> {
    const data = await this.getJson<ClaimsResponse>(WIKIDATA_API, {
      action: 'wbgetclaims',
      entity: qid,
      property,
    });
    const value = data.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
    return typeof value === 'string' && value ? value : undefined;
  }

  /** The Commons file title of the Wikidata portrait (P18), e.g. "File:Name.jpg". */
  async portrait(qid: string): Promise<string | undefined> {
    const name = await this.claimValue(qid, 'P18');
    return name && isRasterTitle(name) ? `File:${name}` : undefined;
  }

  /** Files in the person's Commons category (P373) and its subcategories, breadth first. */
  async categoryFiles(qid: string, opts: { maxDepth: number; limit: number }): Promise<string[]> {
    const root = await this.claimValue(qid, 'P373');
    if (!root) return [];
    const files: string[] = [];
    const seen = new Set<string>();
    let level = [`Category:${root}`];
    for (let depth = 0; depth <= opts.maxDepth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const category of level) {
        if (seen.has(category)) continue;
        seen.add(category);
        const fileMembers = await this.members(category, 'file', opts.limit - files.length);
        for (const title of fileMembers) {
          if (!isRasterTitle(title)) continue;
          if (!files.includes(title)) files.push(title);
          if (files.length >= opts.limit) return files;
        }
        if (depth < opts.maxDepth) next.push(...(await this.members(category, 'subcat', 50)));
      }
      level = next;
    }
    return files;
  }

  private async members(category: string, type: 'file' | 'subcat', limit: number): Promise<string[]> {
    const data = await this.getJson<{ query?: { categorymembers?: { title: string }[] } }>(COMMONS_API, {
      action: 'query',
      list: 'categorymembers',
      cmtitle: category,
      cmtype: type,
      cmlimit: String(Math.max(1, Math.min(limit, 500))),
    });
    return (data.query?.categorymembers ?? []).map((m) => m.title);
  }

  /** An 800 px thumbnail URL and the short license name for a Commons file. */
  async fileInfo(title: string): Promise<{ thumbUrl: string; license: string } | undefined> {
    const data = await this.getJson<{
      query?: {
        pages?: Record<
          string,
          { imageinfo?: { thumburl?: string; extmetadata?: { LicenseShortName?: { value?: string } } }[] }
        >;
      };
    }>(COMMONS_API, {
      action: 'query',
      titles: title,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
      iiurlwidth: '800',
    });
    const page = Object.values(data.query?.pages ?? {})[0];
    const info = page?.imageinfo?.[0];
    const thumbUrl = info?.thumburl;
    if (!info || !thumbUrl) return undefined;
    return { thumbUrl, license: info.extmetadata?.LicenseShortName?.value ?? '' };
  }

  /**
   * CC0, CC BY, CC BY-SA and public domain (including "Public domain mark") only; NC, ND, GFDL, fair use
   * and unknown terms are rejected.
   */
  isOpenLicense(license: string): boolean {
    const l = license.trim().toLowerCase();
    if (/^cc0\b/.test(l)) return true;
    if (/^(public domain|pd)\b/.test(l)) return true;
    return /^cc[ -]by([ -]sa)?([ -]\d|$)/.test(l);
  }
}
