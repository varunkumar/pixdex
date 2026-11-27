// @vitest-environment node
// Node's Blob survives the structured clone fake-indexeddb makes; jsdom's does not. Image decoding is stubbed.
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heroHash, loadHero } from '../heroImage';
import { readHero, writeHero, type HeroRecord } from '../heroStore';

const HASH = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const BYTES = new Uint8Array([0xff, 0xd8, 0, 1, 2, 3, 0xff, 0xd9]);

const fetchMock = vi.fn<typeof fetch>();
const decode = vi.fn<(src: string) => Promise<void>>();

class ImageStub {
  src = '';
  decode() {
    return decode(this.src);
  }
}

const imageResponse = (type = 'image/jpeg') =>
  new Response(BYTES, { status: 200, headers: { 'Content-Type': type } });
const urls = () => fetchMock.mock.calls.map(([url]) => String(url));
const bytesOf = async (blob: Blob | null | undefined) => (blob ? new Uint8Array(await blob.arrayBuffer()) : blob);
const stored = (over: Partial<HeroRecord>): HeroRecord => ({
  album: 'Kanha',
  contentHash: HASH,
  status: 'ready',
  updatedAt: 1,
  ...over,
});
const load = () => loadHero('Kanha', HASH, 'ph1');

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  fetchMock.mockReset();
  decode.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Image', ImageStub);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('heroHash', () => {
  it('returns the part after /thumbnails/', () => {
    expect(heroHash('/thumbnails/abc')).toBe('abc');
  });

  it('returns null when there is no cover thumbnail', () => {
    expect(heroHash(null)).toBeNull();
    expect(heroHash(undefined)).toBeNull();
    expect(heroHash('')).toBeNull();
    expect(heroHash('/something/else')).toBeNull();
  });
});

describe('loadHero from the store', () => {
  it('returns a stored image for this cover without a request', async () => {
    await writeHero(stored({ image: new Blob([BYTES], { type: 'image/jpeg' }) }));

    await expect(bytesOf(await load())).resolves.toEqual(BYTES);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tries an unavailable original again and stores it once it arrives', async () => {
    await writeHero(stored({ status: 'unavailable' }));
    fetchMock.mockResolvedValueOnce(imageResponse());

    await expect(bytesOf(await load())).resolves.toEqual(BYTES);

    expect(urls()).toEqual(['/api/originals/ph1']);
    await expect(readHero('Kanha')).resolves.toMatchObject({ contentHash: HASH, status: 'ready' });
  });

  it('does not try an undecodable original again', async () => {
    await writeHero(stored({ status: 'undecodable' }));

    await expect(load()).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['ready', 'unavailable', 'undecodable'] as const)("replaces another cover's %s record", async (status) => {
    await writeHero(stored({ contentHash: OTHER, status, image: new Blob(['old'], { type: 'image/jpeg' }) }));
    fetchMock.mockResolvedValueOnce(imageResponse());

    await expect(bytesOf(await load())).resolves.toEqual(BYTES);

    expect(urls()).toEqual(['/api/originals/ph1']);
    await expect(readHero('Kanha')).resolves.toMatchObject({ contentHash: HASH, status: 'ready' });
  });

  it('fetches again when a ready record has lost its image', async () => {
    await writeHero(stored({}));
    fetchMock.mockResolvedValueOnce(imageResponse());

    await expect(bytesOf(await load())).resolves.toEqual(BYTES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('loadHero from the original', () => {
  it('stores the response bytes and type unchanged', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse('image/png'));

    const blob = await load();

    expect(blob?.type).toBe('image/png');
    await expect(bytesOf(blob)).resolves.toEqual(BYTES);
    const record = await readHero('Kanha');
    expect(record).toMatchObject({ album: 'Kanha', contentHash: HASH, status: 'ready' });
    expect(record?.updatedAt).toEqual(expect.any(Number));
    expect(record?.image?.type).toBe('image/png');
    await expect(bytesOf(record?.image)).resolves.toEqual(BYTES);
  });

  it('encodes the photo id in the original URL', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse());

    await loadHero('Kanha', HASH, 'a b');

    expect(urls()).toEqual(['/api/originals/a%20b']);
  });

  it('decodes through an object URL and revokes it', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:check');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(imageResponse());

    const blob = await load();

    expect(create).toHaveBeenCalledWith(blob);
    expect(decode).toHaveBeenCalledWith('blob:check');
    expect(revoke).toHaveBeenCalledWith('blob:check');
  });

  it.each([
    ['the request rejects', () => fetchMock.mockRejectedValueOnce(new TypeError('offline'))],
    ['the tunnel answers 502', () => fetchMock.mockResolvedValueOnce(new Response('down', { status: 502 }))],
    [
      'a failing status carries an image type',
      () =>
        fetchMock.mockResolvedValueOnce(
          new Response(BYTES, { status: 500, headers: { 'Content-Type': 'image/jpeg' } })
        ),
    ],
    ['a 200 is an HTML page', () => fetchMock.mockResolvedValueOnce(imageResponse('text/html; charset=utf-8'))],
    ['a 200 has no content type', () => fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))],
    [
      'the body cannot be read',
      () => {
        const response = imageResponse();
        vi.spyOn(response, 'blob').mockRejectedValue(new TypeError('connection reset'));
        fetchMock.mockResolvedValueOnce(response);
      },
    ],
  ])('records unavailable and returns null when %s', async (_name, arrange) => {
    arrange();

    await expect(load()).resolves.toBeNull();

    const record = await readHero('Kanha');
    expect(record).toMatchObject({ album: 'Kanha', contentHash: HASH, status: 'unavailable' });
    expect(record?.image).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
  });

  it('records undecodable and revokes the object URL when the browser cannot decode the image', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    decode.mockRejectedValueOnce(new Error('EncodingError'));
    fetchMock.mockResolvedValueOnce(imageResponse('image/heic'));

    await expect(load()).resolves.toBeNull();

    const record = await readHero('Kanha');
    expect(record).toMatchObject({ contentHash: HASH, status: 'undecodable' });
    expect(record?.image).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('returns the image when it cannot be stored', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    fetchMock.mockResolvedValueOnce(imageResponse());

    await expect(bytesOf(await load())).resolves.toEqual(BYTES);
  });

  it('returns the image when there is no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    fetchMock.mockResolvedValueOnce(imageResponse());

    await expect(bytesOf(await load())).resolves.toEqual(BYTES);
  });

  it('resolves null rather than rejecting when decoding cannot even start', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('no object URLs');
    });
    fetchMock.mockResolvedValueOnce(imageResponse());

    await expect(load()).resolves.toBeNull();
  });
});

describe('loadHero calls at the same time', () => {
  it('share one fetch', async () => {
    fetchMock.mockImplementation(async () => imageResponse());

    const [first, second] = await Promise.all([load(), load()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('do not share across albums or covers', async () => {
    fetchMock.mockImplementation(async () => imageResponse());

    await Promise.all([load(), loadHero('Hampi', HASH, 'ph1'), loadHero('Kanha', OTHER, 'ph2')]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('try again after a shared attempt ended unavailable', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 502 }));

    await expect(Promise.all([load(), load()])).resolves.toEqual([null, null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(load()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
