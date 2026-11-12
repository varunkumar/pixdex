import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, parseRetryAfter, RateLimitedError, WikimediaClient } from '../src/known/wikimedia';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function emptyFetch(): typeof fetch {
  return (async () => jsonResponse({})) as unknown as typeof fetch;
}

describe('isOpenLicense', () => {
  const client = new WikimediaClient(emptyFetch(), { delayMs: 0 });
  it('accepts open licenses', () => {
    for (const l of ['CC BY-SA 4.0', 'CC0', 'Public domain', 'CC BY 2.0', 'CC0 1.0', 'Public domain mark 1.0']) {
      expect(client.isOpenLicense(l), l).toBe(true);
    }
  });
  it('rejects restrictive licenses', () => {
    for (const l of ['CC BY-NC 4.0', 'All rights reserved', 'CC BY-ND 2.0', 'CC BY-NC-SA 3.0', 'GFDL', 'GFDL 1.2', 'Fair use', '']) {
      expect(client.isOpenLicense(l), l).toBe(false);
    }
  });
});

describe('WikimediaClient', () => {
  it('portrait reads P18 and prefixes File:', async () => {
    const urls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)['User-Agent']).toBe('face-gallery-builder/0.1');
      return jsonResponse({ claims: { P18: [{ mainsnak: { datavalue: { value: 'A b.jpg' } } }] } });
    }) as unknown as typeof fetch;
    const c = new WikimediaClient(f, { delayMs: 0 });
    expect(await c.portrait('Q1')).toBe('File:A b.jpg');
    expect(urls[0]).toContain('wikidata.org');
    expect(urls[0]).toContain('P18');
  });

  it('portrait is undefined without P18', async () => {
    const c = new WikimediaClient((async () => jsonResponse({ claims: {} })) as unknown as typeof fetch, { delayMs: 0 });
    expect(await c.portrait('Q1')).toBeUndefined();
  });

  function categoryFetch(): typeof fetch {
    const tree: Record<string, { files: string[]; subs: string[] }> = {
      'Category:Root': { files: ['File:r1.jpg', 'File:r2.jpg'], subs: ['Category:Sub'] },
      'Category:Sub': { files: ['File:s1.jpg', 'File:s2.jpg'], subs: ['Category:Deep'] },
      'Category:Deep': { files: ['File:d1.jpg'], subs: [] },
    };
    return (async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'www.wikidata.org') {
        return jsonResponse({ claims: { P373: [{ mainsnak: { datavalue: { value: 'Root' } } }] } });
      }
      const title = u.searchParams.get('cmtitle')!;
      const type = u.searchParams.get('cmtype');
      const node = tree[title];
      const members = (type === 'file' ? node.files : node.subs).map((t) => ({ title: t }));
      return jsonResponse({ query: { categorymembers: members } });
    }) as unknown as typeof fetch;
  }

  it('categoryFiles stops at maxDepth', async () => {
    const c = new WikimediaClient(categoryFetch(), { delayMs: 0 });
    expect(await c.categoryFiles('Q1', { maxDepth: 0, limit: 50 })).toEqual(['File:r1.jpg', 'File:r2.jpg']);
    expect(await c.categoryFiles('Q1', { maxDepth: 1, limit: 50 })).toEqual([
      'File:r1.jpg',
      'File:r2.jpg',
      'File:s1.jpg',
      'File:s2.jpg',
    ]);
  });

  it('categoryFiles stops at limit', async () => {
    const c = new WikimediaClient(categoryFetch(), { delayMs: 0 });
    expect(await c.categoryFiles('Q1', { maxDepth: 5, limit: 3 })).toEqual(['File:r1.jpg', 'File:r2.jpg', 'File:s1.jpg']);
  });

  it('categoryFiles is empty without P373', async () => {
    const c = new WikimediaClient((async () => jsonResponse({ claims: {} })) as unknown as typeof fetch, { delayMs: 0 });
    expect(await c.categoryFiles('Q1', { maxDepth: 1, limit: 5 })).toEqual([]);
  });

  it('fileInfo returns thumb url and license', async () => {
    const f = (async () =>
      jsonResponse({
        query: {
          pages: {
            '1': {
              imageinfo: [
                { thumburl: 'https://upload/x.jpg', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } },
              ],
            },
          },
        },
      })) as unknown as typeof fetch;
    const c = new WikimediaClient(f, { delayMs: 0 });
    expect(await c.fileInfo('File:x.jpg')).toEqual({ thumbUrl: 'https://upload/x.jpg', license: 'CC BY-SA 4.0' });
  });

  it('fileInfo is undefined when there is no thumburl (never falls back to the original)', async () => {
    const f = (async () =>
      jsonResponse({ query: { pages: { '1': { imageinfo: [{ url: 'https://upload/orig.tif' }] } } } })) as unknown as typeof fetch;
    expect(await new WikimediaClient(f, { delayMs: 0 }).fileInfo('File:x.tif')).toBeUndefined();
  });

  it('fileInfo is undefined when the page has no imageinfo', async () => {
    const c = new WikimediaClient(
      (async () => jsonResponse({ query: { pages: { '-1': {} } } })) as unknown as typeof fetch,
      { delayMs: 0 }
    );
    expect(await c.fileInfo('File:x.jpg')).toBeUndefined();
  });
});

function rl(status: number, retryAfter?: string): Response {
  return new Response('', { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
}

function fakeClock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
}

describe('rate limiting', () => {
  it('honours Retry-After, then succeeds', async () => {
    const clock = fakeClock();
    const responses = [rl(429, '20'), rl(503, '3'), jsonResponse({ claims: {} })];
    const events: number[] = [];
    const c = new WikimediaClient((async () => responses.shift()!) as unknown as typeof fetch, { delayMs: 0, ...clock });
    c.onRateLimit = (s) => events.push(s);
    await c.portrait('Q1');
    expect(clock.waits).toEqual([20_000, 3_000]);
    expect(events).toEqual([20, 3]);
  });

  it('caps Retry-After at 120 s and parses HTTP dates', () => {
    expect(parseRetryAfter('7', 0)).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('nonsense', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it('caps a huge Retry-After and uses jittered exponential backoff without the header', async () => {
    const clock = fakeClock();
    const responses = [rl(429, '9999'), rl(429), rl(429), jsonResponse({ claims: {} })];
    const c = new WikimediaClient((async () => responses.shift()!) as unknown as typeof fetch, {
      delayMs: 0,
      random: () => 0,
      ...clock,
    });
    await c.portrait('Q1');
    expect(clock.waits).toEqual([120_000, 10_000, 20_000]);
  });

  it('throws RateLimitedError on the 6th consecutive 429', async () => {
    const clock = fakeClock();
    let n = 0;
    const f = (async () => {
      n++;
      return rl(429, '1');
    }) as unknown as typeof fetch;
    const c = new WikimediaClient(f, { delayMs: 0, ...clock });
    await expect(c.portrait('Q1')).rejects.toBeInstanceOf(RateLimitedError);
    expect(n).toBe(MAX_ATTEMPTS);
    expect(clock.waits).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it('widens the delay after a 429 (up to 8 s) and decays after 20 successes', async () => {
    const clock = fakeClock();
    let limited = 4;
    const f = (async () => (limited-- > 0 ? rl(429, '1') : jsonResponse({ claims: {} }))) as unknown as typeof fetch;
    const c = new WikimediaClient(f, { delayMs: 1500, ...clock });
    expect(c.paceMs).toBe(1500);
    await c.portrait('Q1');
    expect(c.paceMs).toBe(8000);
    for (let i = 0; i < 20; i++) await c.portrait('Q1');
    expect(c.paceMs).toBe(4000);
    for (let i = 0; i < 60; i++) await c.portrait('Q1');
    expect(c.paceMs).toBe(1500);
  });

  it('paces requests by the current delay', async () => {
    const clock = fakeClock();
    const c = new WikimediaClient((async () => jsonResponse({ claims: {} })) as unknown as typeof fetch, {
      delayMs: 1500,
      ...clock,
    });
    await c.portrait('Q1');
    await c.portrait('Q1');
    expect(clock.waits).toEqual([1500]);
  });

  it('download retries on 429 and throws RateLimitedError when persistent', async () => {
    const clock = fakeClock();
    const ok = [rl(429, '2'), new Response('img', { status: 200 })];
    const c = new WikimediaClient((async () => ok.shift()!) as unknown as typeof fetch, { delayMs: 0, ...clock });
    expect((await c.download('https://upload.wikimedia.org/x.jpg')).toString()).toBe('img');
    const always = new WikimediaClient((async () => rl(429, '1')) as unknown as typeof fetch, { delayMs: 0, ...fakeClock() });
    await expect(always.download('https://upload.wikimedia.org/x.jpg')).rejects.toBeInstanceOf(RateLimitedError);
    const gone = new WikimediaClient((async () => rl(404)) as unknown as typeof fetch, { delayMs: 0 });
    await expect(gone.download('https://x/y.jpg')).rejects.toThrow(/download failed: 404/);
  });
});

describe('raster filter', () => {
  it('skips non-raster category files and portraits without extra requests', async () => {
    const f = (async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'www.wikidata.org') {
        const prop = u.searchParams.get('property');
        const value = prop === 'P18' ? 'Voice.OGG' : 'Root';
        return jsonResponse({ claims: { [prop!]: [{ mainsnak: { datavalue: { value } } }] } });
      }
      const files = ['File:a.JPG', 'File:b.ogg', 'File:c.svg', 'File:d.pdf', 'File:e.tif', 'File:f.webm', 'File:g.PNG', 'File:h.jpeg', 'File:i.webp'];
      return jsonResponse({ query: { categorymembers: u.searchParams.get('cmtype') === 'file' ? files.map((title) => ({ title })) : [] } });
    }) as unknown as typeof fetch;
    const c = new WikimediaClient(f, { delayMs: 0 });
    expect(await c.portrait('Q1')).toBeUndefined();
    expect(await c.categoryFiles('Q1', { maxDepth: 0, limit: 40 })).toEqual(['File:a.JPG', 'File:g.PNG', 'File:h.jpeg', 'File:i.webp']);
  });
});
