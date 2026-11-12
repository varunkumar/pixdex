import { describe, expect, it } from 'vitest';
import { fetchCandidates, searchWikidata } from '../src/known/list';
import { wikimediaContact } from '../src/known/userAgent';
import {
  API_REQUESTS_PER_PERSON,
  IDENTIFIED_DELAY_MS,
  MAX_QUERY_CHARS,
  RateLimitedError,
  UNIDENTIFIED_DELAY_MS,
  WikimediaClient,
} from '../src/known/wikimedia';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function rl(status: number, retryAfter?: string): Response {
  return new Response('', { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
}

function entities(map: Record<string, Record<string, string>>) {
  const out: Record<string, unknown> = {};
  for (const [id, props] of Object.entries(map)) {
    out[id] = {
      id,
      claims: Object.fromEntries(Object.entries(props).map(([p, v]) => [p, [{ mainsnak: { datavalue: { value: v } } }]])),
    };
  }
  return { entities: out };
}

function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function wikiFetch(opts: { onUrl?: (u: URL, init?: RequestInit) => void; fail?: (u: URL) => boolean } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    opts.onUrl?.(u, init);
    if (opts.fail?.(u)) return rl(429, '1');
    const params = u.searchParams;
    if (params.get('action') === 'wbgetentities') {
      const ids = params.get('ids')!.split('|');
      return jsonResponse(entities(Object.fromEntries(ids.map((id) => [id, { P18: `${id}.jpg`, P373: `C${id}` }]))));
    }
    if (params.get('list') === 'categorymembers') {
      const cat = params.get('cmtitle')!;
      const root = cat === 'Category:CQ1';
      const files = root ? Array.from({ length: 30 }, (_, i) => `File:r${i}.jpg`) : ['File:s.jpg'];
      const subs = root ? ['Category:Sub1', 'Category:Sub2'] : [];
      return jsonResponse({
        query: {
          categorymembers: [
            ...(params.get('cmtype')!.includes('subcat') ? subs.map((title) => ({ title, type: 'subcat' })) : []),
            ...files.map((title) => ({ title, type: 'file' })),
          ],
        },
      });
    }
    if (params.get('titles') === null) return jsonResponse({});
    const pages: Record<string, unknown> = {};
    params
      .get('titles')!
      .split('|')
      .forEach((t, i) => {
        if (t.includes('missing')) pages[String(-1 - i)] = { title: t, missing: '' };
        else
          pages[String(i + 1)] = {
            title: t,
            imageinfo: [{ thumburl: `https://upload/${t}`, extmetadata: { LicenseShortName: { value: 'CC0' } } }],
          };
      });
    return jsonResponse({ query: { pages } });
  }) as unknown as typeof fetch;
}

describe('User-Agent and contact', () => {
  it('validates WIKIMEDIA_CONTACT loosely and never echoes an invalid value', () => {
    expect(wikimediaContact({}).contact).toBeUndefined();
    expect(wikimediaContact({ WIKIMEDIA_CONTACT: '  ' })).toEqual({});
    expect(wikimediaContact({ WIKIMEDIA_CONTACT: 'me@example.org' }).contact).toBe('me@example.org');
    const bad = wikimediaContact({ WIKIMEDIA_CONTACT: 'a\nb@example.org' });
    expect(bad.contact).toBeUndefined();
    expect(bad.warning).toBeDefined();
    expect(bad.warning).not.toContain('example.org');
    expect(wikimediaContact({ WIKIMEDIA_CONTACT: 'x'.repeat(201) }).contact).toBeUndefined();
  });

  it('sends the contact on every client path, and the generic agent without one', async () => {
    for (const contact of ['me@example.org', undefined]) {
      const agents: string[] = [];
      const f = wikiFetch({ onUrl: (_u, init) => agents.push((init?.headers as Record<string, string>)['User-Agent']) });
      const c = new WikimediaClient(f, { delayMs: 0, contact });
      await c.prefetch(['Q1']);
      await c.categoryFiles('Q1', { maxDepth: 1, limit: 5 });
      await c.fileInfos(['File:a.jpg']);
      await c.download('https://upload.wikimedia.org/x.jpg');
      expect(agents.length).toBeGreaterThanOrEqual(4);
      const expected = contact ? 'face-gallery-builder/0.1 (me@example.org)' : 'face-gallery-builder/0.1';
      for (const a of agents) expect(a).toBe(expected);
    }
  });

  it('sends the contact from the Wikidata helpers used by known-search, known-add and known-check', async () => {
    const agents: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      agents.push((init?.headers as Record<string, string>)['User-Agent']);
      const u = new URL(url);
      if (u.searchParams.get('action') === 'wbsearchentities') return jsonResponse({ search: [{ id: 'Q1' }] });
      return jsonResponse({ entities: { Q1: { id: 'Q1', labels: { en: { value: 'A' } } } } });
    }) as unknown as typeof fetch;
    await searchWikidata('a', { fetchFn: f, delayMs: 0, contact: 'me@example.org' });
    await fetchCandidates(['Q1'], { fetchFn: f, delayMs: 0, contact: 'me@example.org' });
    await fetchCandidates(['Q1'], { fetchFn: f, delayMs: 0 });
    expect(agents.slice(0, 3).every((a) => a === 'face-gallery-builder/0.1 (me@example.org)')).toBe(true);
    expect(agents[3]).toBe('face-gallery-builder/0.1');
  });

  it('never puts the contact in error messages', async () => {
    const c = new WikimediaClient((async () => rl(500)) as unknown as typeof fetch, {
      delayMs: 0,
      contact: 'secret@example.org',
    });
    await expect(c.fileInfo('File:a.jpg')).rejects.toThrow(/^(?!.*secret@example\.org)/);
  });
});

describe('bucket pacing', () => {
  it('defaults to 1500 ms with a contact and 6500 ms without, and the option overrides', () => {
    const f = wikiFetch();
    expect(new WikimediaClient(f, { contact: 'me@example.org' }).paceMs).toBe(IDENTIFIED_DELAY_MS);
    expect(new WikimediaClient(f).paceMs).toBe(UNIDENTIFIED_DELAY_MS);
    expect(IDENTIFIED_DELAY_MS).toBe(1500);
    expect(UNIDENTIFIED_DELAY_MS).toBe(6500);
    expect(new WikimediaClient(f, { delayMs: 10 }).paceMs).toBe(10);
  });
});

describe('batching', () => {
  it('fileInfos sends 51 titles as 2 requests and maps results back, missing titles undefined', async () => {
    const seen: number[] = [];
    const c = new WikimediaClient(wikiFetch({ onUrl: (u) => seen.push(u.searchParams.get('titles')!.split('|').length) }), {
      delayMs: 0,
    });
    const titles = Array.from({ length: 51 }, (_, i) => (i === 7 ? 'File:missing.jpg' : `File:p${i}.jpg`));
    const res = await c.fileInfos(titles);
    expect(seen).toEqual([50, 1]);
    expect(res.get('File:p3.jpg')).toEqual({ thumbUrl: 'https://upload/File:p3.jpg', license: 'CC0' });
    expect(res.get('File:p50.jpg')?.thumbUrl).toBe('https://upload/File:p50.jpg');
    expect(res.get('File:missing.jpg')).toBeUndefined();
    await c.fileInfos(titles);
    expect(seen).toHaveLength(2);
  });

  it('maps normalized titles back to the requested spelling', async () => {
    const f = (async () =>
      jsonResponse({
        query: {
          normalized: [{ from: 'File:a_b.jpg', to: 'File:A b.jpg' }],
          pages: { '1': { title: 'File:A b.jpg', imageinfo: [{ thumburl: 'https://upload/ab.jpg' }] } },
        },
      })) as unknown as typeof fetch;
    const res = await new WikimediaClient(f, { delayMs: 0 }).fileInfos(['File:a_b.jpg']);
    expect(res.get('File:a_b.jpg')?.thumbUrl).toBe('https://upload/ab.jpg');
  });

  it('prefetch resolves 405 ids in 9 requests and portrait/categoryFiles then cost no Wikidata calls', async () => {
    let wikidata = 0;
    const c = new WikimediaClient(
      wikiFetch({
        onUrl: (u) => {
          if (u.hostname === 'www.wikidata.org') wikidata++;
        },
      }),
      { delayMs: 0 }
    );
    await c.prefetch(Array.from({ length: 405 }, (_, i) => `Q${i + 1}`));
    expect(wikidata).toBe(9);
    expect(await c.portrait('Q2')).toBe('File:Q2.jpg');
    await c.categoryFiles('Q2', { maxDepth: 0, limit: 5 });
    expect(wikidata).toBe(9);
  });

  it('a persistently failed batch marks only its people failed', async () => {
    const f = wikiFetch({ fail: (u) => u.searchParams.get('ids')?.startsWith('Q51|') === true });
    const c = new WikimediaClient(f, { delayMs: 0, ...fakeClock() });
    await c.prefetch(Array.from({ length: 101 }, (_, i) => `Q${i + 1}`));
    expect(await c.portrait('Q1')).toBe('File:Q1.jpg');
    await expect(c.portrait('Q51')).rejects.toBeInstanceOf(RateLimitedError);
    await expect(c.portrait('Q100')).rejects.toBeInstanceOf(RateLimitedError);
    expect(await c.portrait('Q101')).toBe('File:Q101.jpg');
  });

  it('follows category continuation until enough raster files', async () => {
    const calls: Record<string, string>[] = [];
    const f = (async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'www.wikidata.org') return jsonResponse(entities({ Q1: { P373: 'Root' } }));
      calls.push(Object.fromEntries(u.searchParams));
      const first = !u.searchParams.has('cmcontinue');
      return jsonResponse({
        query: { categorymembers: [{ title: first ? 'File:a.ogg' : 'File:b.jpg', type: 'file' }] },
        ...(first ? { continue: { cmcontinue: 'x', continue: '-||' } } : {}),
      });
    }) as unknown as typeof fetch;
    const files = await new WikimediaClient(f, { delayMs: 0 }).categoryFiles('Q1', { maxDepth: 0, limit: 1 });
    expect(files).toEqual(['File:b.jpg']);
    expect(calls).toHaveLength(2);
    expect(calls[0].cmlimit).toBe('500');
    expect(calls[1].cmcontinue).toBe('x');
  });

  it('a typical person costs 4 API requests (before batching: 2 claims + 4 category + 31 file lookups = 37)', async () => {
    let n = 0;
    const c = new WikimediaClient(wikiFetch({ onUrl: () => n++ }), { delayMs: 0 });
    await c.prefetch(['Q1']);
    const afterPrefetch = n;
    const files = await c.categoryFiles('Q1', { maxDepth: 1, limit: 40 });
    const portrait = await c.portrait('Q1');
    await c.fileInfos([portrait!, ...files]);
    expect(n - afterPrefetch).toBe(API_REQUESTS_PER_PERSON);
    expect(API_REQUESTS_PER_PERSON).toBe(4);
  });
});

describe('URL length cap', () => {
  it('chunks long fileInfos titles so no request URL exceeds the cap, and all titles resolve', async () => {
    const urls: URL[] = [];
    const c = new WikimediaClient(wikiFetch({ onUrl: (u) => urls.push(u) }), { delayMs: 0 });
    const titles = Array.from({ length: 50 }, (_, i) => `File:${'\u00e9 long title '.repeat(10)}${i}.jpg`);
    const infos = await c.fileInfos(titles);
    expect(urls.length).toBeGreaterThan(1);
    for (const u of urls) {
      expect(u.search.length).toBeLessThanOrEqual(MAX_QUERY_CHARS + 200);
      expect((u.searchParams.get('titles') ?? '').split('|').length).toBeLessThanOrEqual(50);
    }
    expect(infos.size).toBe(50);
    for (const t of titles) expect(infos.get(t)?.thumbUrl).toBe(`https://upload/${t}`);
  });

  it('still uses one request for 50 short titles', async () => {
    const urls: URL[] = [];
    const c = new WikimediaClient(wikiFetch({ onUrl: (u) => urls.push(u) }), { delayMs: 0 });
    await c.fileInfos(Array.from({ length: 50 }, (_, i) => `File:s${i}.jpg`));
    expect(urls).toHaveLength(1);
  });

  it('chunks prefetch ids by length too', async () => {
    const urls: URL[] = [];
    const c = new WikimediaClient(wikiFetch({ onUrl: (u) => urls.push(u) }), { delayMs: 0 });
    const ids = Array.from({ length: 50 }, (_, i) => `Q${'1'.repeat(300)}${i}`);
    await c.prefetch(ids);
    expect(urls.length).toBeGreaterThan(1);
    for (const u of urls) expect(u.search.length).toBeLessThanOrEqual(MAX_QUERY_CHARS + 200);
    expect(await c.portrait(ids[49])).toBe(`File:${ids[49]}.jpg`);
  });
});
