const USER_AGENT = 'face-gallery-builder/0.1';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ClaimsResponse {
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>;
}

/**
 * Read-only client for Wikidata and Wikimedia Commons. Polite by construction: a generic User-Agent,
 * a minimum delay between requests, and one retry on HTTP 429 after a longer sleep.
 */
export class WikimediaClient {
  private lastRequestAt = 0;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly delayMs: number = 800,
    private readonly retryDelayMs: number = 5_000
  ) {}

  private async getJson<T>(base: string, params: Record<string, string>): Promise<T> {
    const url = `${base}?${new URLSearchParams({ format: 'json', ...params }).toString()}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      const response = await this.fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempt === 0) {
        await sleep(this.retryDelayMs);
        continue;
      }
      if (!response.ok) throw new Error(`Wikimedia request failed: ${response.status}`);
      return (await response.json()) as T;
    }
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
    return name ? `File:${name}` : undefined;
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
          { imageinfo?: { thumburl?: string; url?: string; extmetadata?: { LicenseShortName?: { value?: string } } }[] }
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
    const thumbUrl = info?.thumburl ?? info?.url;
    if (!info || !thumbUrl) return undefined;
    return { thumbUrl, license: info.extmetadata?.LicenseShortName?.value ?? '' };
  }

  /** CC0, CC BY, CC BY-SA and public domain only (no NC, ND or unknown terms). */
  isOpenLicense(license: string): boolean {
    const l = license.trim().toLowerCase();
    if (/^cc0\b/.test(l)) return true;
    if (/^(public domain|pd)\b/.test(l)) return true;
    return /^cc[ -]by([ -]sa)?([ -]\d|$)/.test(l);
  }
}
