import { describe, expect, it } from 'vitest';
import { WikimediaClient } from '../src/known/wikimedia';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function emptyFetch(): typeof fetch {
  return (async () => jsonResponse({})) as unknown as typeof fetch;
}

describe('isOpenLicense', () => {
  const client = new WikimediaClient(emptyFetch(), 0);
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
    const c = new WikimediaClient(f, 0);
    expect(await c.portrait('Q1')).toBe('File:A b.jpg');
    expect(urls[0]).toContain('wikidata.org');
    expect(urls[0]).toContain('P18');
  });

  it('portrait is undefined without P18', async () => {
    const c = new WikimediaClient((async () => jsonResponse({ claims: {} })) as unknown as typeof fetch, 0);
    expect(await c.portrait('Q1')).toBeUndefined();
  });

  it('retries once on 429 then succeeds, and fails after a second 429', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n === 1 ? new Response('', { status: 429 }) : jsonResponse({ claims: {} });
    }) as unknown as typeof fetch;
    const c = new WikimediaClient(f, 0, 0);
    await c.portrait('Q1');
    expect(n).toBe(2);
    const always = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    await expect(new WikimediaClient(always, 0, 0).portrait('Q1')).rejects.toThrow(/429/);
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
    const c = new WikimediaClient(categoryFetch(), 0);
    expect(await c.categoryFiles('Q1', { maxDepth: 0, limit: 50 })).toEqual(['File:r1.jpg', 'File:r2.jpg']);
    expect(await c.categoryFiles('Q1', { maxDepth: 1, limit: 50 })).toEqual([
      'File:r1.jpg',
      'File:r2.jpg',
      'File:s1.jpg',
      'File:s2.jpg',
    ]);
  });

  it('categoryFiles stops at limit', async () => {
    const c = new WikimediaClient(categoryFetch(), 0);
    expect(await c.categoryFiles('Q1', { maxDepth: 5, limit: 3 })).toEqual(['File:r1.jpg', 'File:r2.jpg', 'File:s1.jpg']);
  });

  it('categoryFiles is empty without P373', async () => {
    const c = new WikimediaClient((async () => jsonResponse({ claims: {} })) as unknown as typeof fetch, 0);
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
    const c = new WikimediaClient(f, 0);
    expect(await c.fileInfo('File:x.jpg')).toEqual({ thumbUrl: 'https://upload/x.jpg', license: 'CC BY-SA 4.0' });
  });

  it('fileInfo is undefined when there is no thumburl (never falls back to the original)', async () => {
    const f = (async () =>
      jsonResponse({ query: { pages: { '1': { imageinfo: [{ url: 'https://upload/orig.tif' }] } } } })) as unknown as typeof fetch;
    expect(await new WikimediaClient(f, 0).fileInfo('File:x.tif')).toBeUndefined();
  });

  it('fileInfo is undefined when the page has no imageinfo', async () => {
    const c = new WikimediaClient(
      (async () => jsonResponse({ query: { pages: { '-1': {} } } })) as unknown as typeof fetch,
      0
    );
    expect(await c.fileInfo('File:x.jpg')).toBeUndefined();
  });
});
