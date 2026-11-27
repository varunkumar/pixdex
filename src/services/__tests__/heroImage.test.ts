// @vitest-environment node
// Node's Blob survives the structured clone fake-indexeddb makes; jsdom's does not. Image decoding is stubbed.
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heroHash, loadHero } from '../heroImage';
import { markHeroUnavailable, readHero, writeHero, type HeroRecord } from '../heroStore';

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

  it('asks past the HTTP cache, so a retry reaches the network', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse('text/html'));

    await load();

    expect(fetchMock).toHaveBeenCalledWith('/api/originals/ph1', expect.objectContaining({ cache: 'no-store' }));
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
        const body = new ReadableStream({ start: (controller) => controller.error(new TypeError('connection reset')) });
        fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
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

describe('loadHero and a refused response', () => {
  /** A response whose body only ends by being cancelled. */
  const openResponse = (status: number, type: string, cancel: () => Promise<void> | void) =>
    new Response(new ReadableStream({ cancel }), { status, headers: { 'Content-Type': type } });

  it.each([
    ['a failing status', 502, 'image/jpeg'],
    ['not an image', 200, 'text/html'],
  ])('cancels the body of %s', async (_name, status, type) => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(openResponse(status, type, cancel));

    await expect(load()).resolves.toBeNull();

    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(readHero('Kanha')).resolves.toMatchObject({ status: 'unavailable' });
  });

  it.each([
    ['fails', () => Promise.reject(new Error('cannot cancel'))],
    ['never finishes', () => new Promise<void>(() => {})],
  ])('still records unavailable when cancelling %s', async (_name, cancel) => {
    fetchMock.mockResolvedValueOnce(openResponse(502, 'text/plain', cancel));

    await expect(load()).resolves.toBeNull();

    await expect(readHero('Kanha')).resolves.toMatchObject({ status: 'unavailable' });
  });
});

describe('markHeroUnavailable', () => {
  it('drops a stored image that will not show, so the next call fetches it again', async () => {
    await writeHero(stored({ image: new Blob(['lost'], { type: 'image/jpeg' }) }));

    await markHeroUnavailable('Kanha', HASH);

    const record = await readHero('Kanha');
    expect(record).toMatchObject({ album: 'Kanha', contentHash: HASH, status: 'unavailable' });
    expect(record?.image).toBeUndefined();
    expect(record?.updatedAt).toBeGreaterThan(1);
    fetchMock.mockResolvedValueOnce(imageResponse());
    await expect(bytesOf(await load())).resolves.toEqual(BYTES);
    expect(urls()).toEqual(['/api/originals/ph1']);
    await expect(readHero('Kanha')).resolves.toMatchObject({ contentHash: HASH, status: 'ready' });
  });

  it("leaves another cover's record alone", async () => {
    await writeHero(stored({ contentHash: OTHER, image: new Blob([BYTES], { type: 'image/jpeg' }) }));

    await markHeroUnavailable('Kanha', HASH);

    const record = await readHero('Kanha');
    expect(record).toMatchObject({ contentHash: OTHER, status: 'ready', updatedAt: 1 });
    await expect(bytesOf(record?.image)).resolves.toEqual(BYTES);
  });

  it('writes nothing when there is no record', async () => {
    await markHeroUnavailable('Kanha', HASH);

    await expect(readHero('Kanha')).resolves.toBeNull();
  });

  it('resolves when there is no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(markHeroUnavailable('Kanha', HASH)).resolves.toBeUndefined();
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

describe('loadHero when something never settles', () => {
  beforeEach(() => {
    // Only the timeouts are faked: fake-indexeddb runs on setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets pending work run, without moving the clock, until the condition holds. */
  const until = async (done: () => boolean) => {
    for (let turn = 0; turn < 200 && !done(); turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(done()).toBe(true);
  };

  /** Starts a load and tracks whether it has settled. */
  const start = () => {
    const state = { settled: false, promise: load() };
    void state.promise.then(() => (state.settled = true));
    return state;
  };

  /** A body the test feeds by hand; like a real one, it fails when the request is aborted. */
  const handFedResponse = () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    });
    return { push: (bytes: Uint8Array) => body.enqueue(bytes), end: () => body.close() };
  };

  const fetchesAgain = async () => {
    fetchMock.mockResolvedValueOnce(imageResponse());
    await expect(bytesOf(await load())).resolves.toEqual(BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  };

  it('gives up on a request with no answer after 30 seconds, and a later call fetches again', async () => {
    // Like real fetch: settles only by being aborted.
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const first = start();
    await until(() => fetchMock.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(first.promise).resolves.toBeNull();
    await expect(readHero('Kanha')).resolves.toMatchObject({ status: 'unavailable' });
    await fetchesAgain();
  });

  it('gives up on a body that stalls for 30 seconds, and a later call fetches again', async () => {
    const response = handFedResponse();
    const first = start();
    await until(() => fetchMock.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(20_000);
    response.push(BYTES.slice(0, 3));
    // Let the chunk be read before the clock moves on.
    await new Promise((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(first.promise).resolves.toBeNull();
    const record = await readHero('Kanha');
    expect(record).toMatchObject({ status: 'unavailable' });
    expect(record?.image).toBeUndefined();
    await fetchesAgain();
  });

  it('lets a slow download finish while bytes keep arriving', async () => {
    const response = handFedResponse();
    const first = start();
    await until(() => fetchMock.mock.calls.length === 1);

    for (let at = 0; at < BYTES.length; at += 2) {
      await vi.advanceTimersByTimeAsync(25_000);
      response.push(BYTES.slice(at, at + 2));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(25_000);
    expect(first.settled).toBe(false);
    response.end();

    const blob = await first.promise;
    expect(blob?.type).toBe('image/jpeg');
    await expect(bytesOf(blob)).resolves.toEqual(BYTES);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still fetches and returns the image when the store never opens, again on a later call', async () => {
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => ({}) as IDBOpenDBRequest);
    fetchMock.mockImplementation(async () => imageResponse());

    for (const call of [1, 2]) {
      const attempt = start();
      // The read gives up, then the write does.
      await vi.advanceTimersByTimeAsync(3_000);
      await until(() => open.mock.calls.length === call * 2);
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(bytesOf(await attempt.promise)).resolves.toEqual(BYTES);
      expect(fetchMock).toHaveBeenCalledTimes(call);
    }
  });

  it('returns the downloaded image when the write never finishes, and a later call fetches again', async () => {
    const transaction = IDBDatabase.prototype.transaction;
    const put = vi.fn(() => ({}));
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      if (args[1] !== 'readwrite') return transaction.apply(this, args);
      return { objectStore: () => ({ put }) } as never;
    });
    fetchMock.mockImplementation(async () => imageResponse());
    const first = start();
    await until(() => put.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(bytesOf(await first.promise)).resolves.toEqual(BYTES);
    const second = start();
    await until(() => put.mock.calls.length === 2);
    await vi.advanceTimersByTimeAsync(3_000);
    await second.promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
