import { userAgentFor } from './userAgent';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Minimum delay between API requests. Wikimedia (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
 * allows 200 requests per minute to a bot that identifies itself and 10 per minute to an unidentified client.
 */
export const IDENTIFIED_DELAY_MS = 1_500;
export const UNIDENTIFIED_DELAY_MS = 6_500;
/** Image downloads from upload.wikimedia.org are not Action API requests; they get a lighter pace. */
export const DOWNLOAD_DELAY_MS = 500;
/** Measured API requests per typical person after batching (see the request-count test). */
export const API_REQUESTS_PER_PERSON = 4;
export const MAX_DELAY_MS = 8_000;
export const MAX_ATTEMPTS = 6;
const BATCH = 50;
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
  /** Base minimum delay between API requests; defaults by bucket (contact set or not). */
  delayMs?: number;
  /** Already validated WIKIMEDIA_CONTACT (an email or URL), sent in the User-Agent. Never logged. */
  contact?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 0..1, for backoff jitter. */
  random?: () => number;
  /** Called once per rate-limit wait, with the wait in seconds. */
  onRateLimit?: (seconds: number) => void;
}

export interface FileInfo {
  thumbUrl: string;
  license: string;
}

interface Entity {
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>;
}

interface Pace {
  base: number;
  current: number;
  last: number;
  successes: number;
}

type Lane = 'api' | 'download';

function claimString(entity: Entity | undefined, property: string): string | undefined {
  const value = entity?.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Read-only client for Wikidata and Wikimedia Commons. Polite by construction: a User-Agent that carries the
 * optional contact, a minimum delay between requests that doubles after a 429 (up to 8 s) and halves after every
 * 20 successes, Retry-After (or exponential backoff) on 429/503 for up to 6 attempts, then RateLimitedError, and
 * batched lookups (50 ids or titles per request). Requests are strictly sequential (at most 1 in flight).
 */
export class WikimediaClient {
  private readonly pace: Record<Lane, Pace>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly userAgent: string;
  private readonly entities = new Map<string, Entity | undefined>();
  private readonly entityErrors = new Map<string, Error>();
  private readonly infos = new Map<string, FileInfo | undefined>();
  onRateLimit?: (seconds: number) => void;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    opts: WikimediaOptions = {}
  ) {
    const base = opts.delayMs ?? (opts.contact ? IDENTIFIED_DELAY_MS : UNIDENTIFIED_DELAY_MS);
    const download = Math.min(base, DOWNLOAD_DELAY_MS);
    this.pace = {
      api: { base, current: base, last: 0, successes: 0 },
      download: { base: download, current: download, last: 0, successes: 0 },
    };
    this.userAgent = userAgentFor(opts.contact);
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.onRateLimit = opts.onRateLimit;
  }

  /** The current minimum delay between API requests (for tests and progress output). */
  get paceMs(): number {
    return this.pace.api.current;
  }

  private async request(url: string, lane: Lane = 'api'): Promise<Response> {
    const pace = this.pace[lane];
    for (let attempt = 1; ; attempt++) {
      const wait = pace.last + pace.current - this.now();
      if (wait > 0) await this.sleep(wait);
      pace.last = this.now();
      const response = await this.fetchFn(url, {
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 429 && response.status !== 503) {
        if (response.ok && ++pace.successes >= DECAY_AFTER_SUCCESSES) {
          pace.successes = 0;
          pace.current = Math.max(pace.base, Math.floor(pace.current / 2));
        }
        return response;
      }
      pace.successes = 0;
      pace.current = Math.min(MAX_DELAY_MS, Math.max(pace.current, pace.base) * 2);
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

  /** Downloads an image with Retry-After handling; a persistent 429 throws RateLimitedError. */
  async download(url: string): Promise<Buffer> {
    const response = await this.request(url, 'download');
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Resolves the claims (P18, P373) of many people, 50 ids per request, and caches them for the run. A batch that
   * still fails after the retries marks only its ids as failed: portrait()/categoryFiles() throw for them (the
   * person is failed, not excluded); nothing is thrown here.
   */
  async prefetch(qids: string[]): Promise<void> {
    const todo = [...new Set(qids)].filter((q) => !this.entities.has(q) && !this.entityErrors.has(q));
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      try {
        const data = await this.getJson<{ entities?: Record<string, Entity & { missing?: string }> }>(WIKIDATA_API, {
          action: 'wbgetentities',
          ids: batch.join('|'),
          props: 'claims',
        });
        for (const q of batch) {
          const e = data.entities?.[q];
          this.entities.set(q, e && !('missing' in e) ? e : undefined);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const q of batch) this.entityErrors.set(q, error);
      }
    }
  }

  private async entity(qid: string): Promise<Entity | undefined> {
    if (!this.entities.has(qid) && !this.entityErrors.has(qid)) await this.prefetch([qid]);
    const error = this.entityErrors.get(qid);
    if (error) throw error;
    return this.entities.get(qid);
  }

  /** The Commons file title of the Wikidata portrait (P18), e.g. "File:Name.jpg"; raster files only. */
  async portrait(qid: string): Promise<string | undefined> {
    const name = claimString(await this.entity(qid), 'P18');
    return name && isRasterTitle(name) ? `File:${name}` : undefined;
  }

  /** Raster files in the person's Commons category (P373) and its subcategories, breadth first. */
  async categoryFiles(qid: string, opts: { maxDepth: number; limit: number }): Promise<string[]> {
    const root = claimString(await this.entity(qid), 'P373');
    if (!root) return [];
    const files: string[] = [];
    const seen = new Set<string>();
    let level = [`Category:${root}`];
    for (let depth = 0; depth <= opts.maxDepth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const category of level) {
        if (seen.has(category)) continue;
        seen.add(category);
        const { fileTitles, subcats } = await this.members(category, opts.limit - files.length, depth < opts.maxDepth);
        for (const title of fileTitles) {
          if (!files.includes(title)) files.push(title);
          if (files.length >= opts.limit) return files;
        }
        next.push(...subcats.slice(0, 50));
      }
      level = next;
    }
    return files;
  }

  /** Files and subcategories in one listing at the largest page size (500); follows continuation until enough raster files. */
  private async members(
    category: string,
    wantFiles: number,
    wantSubcats: boolean
  ): Promise<{ fileTitles: string[]; subcats: string[] }> {
    const fileTitles: string[] = [];
    const subcats: string[] = [];
    let cont: Record<string, string> = {};
    for (;;) {
      const data = await this.getJson<{
        query?: { categorymembers?: { title: string; type?: string }[] };
        continue?: Record<string, string>;
      }>(COMMONS_API, {
        action: 'query',
        list: 'categorymembers',
        cmtitle: category,
        cmtype: wantSubcats ? 'file|subcat' : 'file',
        cmprop: 'title|type',
        cmlimit: '500',
        ...cont,
      });
      for (const m of data.query?.categorymembers ?? []) {
        if (m.type === 'subcat') subcats.push(m.title);
        else if (isRasterTitle(m.title)) fileTitles.push(m.title);
      }
      if (!data.continue || fileTitles.length >= wantFiles) break;
      cont = data.continue;
    }
    return { fileTitles, subcats };
  }

  /** Thumbnail URL and license for many Commons files, 50 titles per request. Missing or non-image titles map to undefined. */
  async fileInfos(titles: string[]): Promise<Map<string, FileInfo | undefined>> {
    const todo = [...new Set(titles)].filter((t) => !this.infos.has(t));
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const data = await this.getJson<{
        query?: {
          normalized?: { from: string; to: string }[];
          pages?: Record<
            string,
            { title?: string; imageinfo?: { thumburl?: string; extmetadata?: { LicenseShortName?: { value?: string } } }[] }
          >;
        };
      }>(COMMONS_API, {
        action: 'query',
        titles: batch.join('|'),
        prop: 'imageinfo',
        iiprop: 'url|extmetadata',
        iiurlwidth: '800',
      });
      const byTitle = new Map<string, FileInfo>();
      for (const page of Object.values(data.query?.pages ?? {})) {
        const info = page.imageinfo?.[0];
        if (page.title && info?.thumburl) {
          byTitle.set(page.title, { thumbUrl: info.thumburl, license: info.extmetadata?.LicenseShortName?.value ?? '' });
        }
      }
      const normalized = new Map((data.query?.normalized ?? []).map((n) => [n.from, n.to]));
      for (const t of batch) this.infos.set(t, byTitle.get(normalized.get(t) ?? t));
    }
    return new Map(titles.map((t) => [t, this.infos.get(t)]));
  }

  /** An 800 px thumbnail URL and the short license name for a Commons file. */
  async fileInfo(title: string): Promise<FileInfo | undefined> {
    return (await this.fileInfos([title])).get(title);
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
