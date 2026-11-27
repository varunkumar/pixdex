// @vitest-environment node
// Node's Blob survives the structured clone fake-indexeddb makes; jsdom's does not.
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHero, writeHero, type HeroRecord } from '../heroStore';

const record = (over: Partial<HeroRecord> = {}): HeroRecord => ({
  album: 'Kanha',
  contentHash: 'a'.repeat(32),
  status: 'ready',
  image: new Blob(['picture'], { type: 'image/jpeg' }),
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  // A new factory per test: an empty database.
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('heroStore', () => {
  it('reads back what was written, image bytes included', async () => {
    await writeHero(record());

    const stored = await readHero('Kanha');

    expect(stored).toMatchObject({ album: 'Kanha', contentHash: 'a'.repeat(32), status: 'ready', updatedAt: 1 });
    expect(stored?.image?.type).toBe('image/jpeg');
    await expect(stored?.image?.text()).resolves.toBe('picture');
  });

  it('keeps one record per album: a second write replaces it', async () => {
    await writeHero(record());
    await writeHero(record({ contentHash: 'b'.repeat(32), status: 'unavailable', image: undefined, updatedAt: 2 }));

    const stored = await readHero('Kanha');

    expect(stored).toEqual({ album: 'Kanha', contentHash: 'b'.repeat(32), status: 'unavailable', updatedAt: 2 });
  });

  it('keeps albums apart', async () => {
    await writeHero(record());
    await writeHero(record({ album: 'Hampi', updatedAt: 5 }));

    await expect(readHero('Kanha')).resolves.toMatchObject({ updatedAt: 1 });
    await expect(readHero('Hampi')).resolves.toMatchObject({ updatedAt: 5 });
  });

  it('reads null for an unknown album', async () => {
    await expect(readHero('Nowhere')).resolves.toBeNull();
  });

  it('reads null and writes nothing, without rejecting, when there is no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(writeHero(record())).resolves.toBeUndefined();
    await expect(readHero('Kanha')).resolves.toBeNull();
  });

  it('does not reject when opening throws', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    await expect(writeHero(record())).resolves.toBeUndefined();
    await expect(readHero('Kanha')).resolves.toBeNull();
  });

  it('does not reject when the open request fails', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      const request = { error: new DOMException('denied', 'UnknownError') } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => request.onerror?.(new Event('error')));
      return request;
    });

    await expect(writeHero(record())).resolves.toBeUndefined();
    await expect(readHero('Kanha')).resolves.toBeNull();
  });

  it('does not reject when put throws', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });

    await expect(writeHero(record())).resolves.toBeUndefined();
    await expect(readHero('Kanha')).resolves.toBeNull();
  });

  it('does not reject when the write transaction is aborted, as on a full disk', async () => {
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      this.transaction.abort();
      return request;
    });

    await expect(writeHero(record())).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    await expect(readHero('Kanha')).resolves.toBeNull();
  });
});

describe('heroStore when IndexedDB never answers', () => {
  beforeEach(() => {
    // Only the timeouts are faked: fake-indexeddb runs on setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An open request the test settles by hand, or never. */
  const pendingOpen = () => {
    const close = vi.fn();
    const request = { result: { close } } as unknown as IDBOpenDBRequest;
    vi.spyOn(indexedDB, 'open').mockReturnValue(request);
    return { request, close };
  };

  const track = (promise: Promise<unknown>) => {
    const state = { settled: false, promise };
    void promise.then(() => (state.settled = true));
    return state;
  };

  const operations: [string, () => Promise<unknown>, null | undefined][] = [
    ['read', () => readHero('Kanha'), null],
    ['write', () => writeHero(record()), undefined],
  ];

  it.each(operations)('gives up on a %s whose open never settles after 3 seconds', async (_name, operation, outcome) => {
    pendingOpen();
    const state = track(operation());

    await vi.advanceTimersByTimeAsync(2_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(state.promise).resolves.toBe(outcome);
  });

  it('closes a connection that opens after the time is up', async () => {
    const { request, close } = pendingOpen();
    const read = readHero('Kanha');
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(read).resolves.toBeNull();

    request.onsuccess?.(new Event('success'));

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('gives up at once when the open is blocked, and closes the connection if it opens later', async () => {
    const { request, close } = pendingOpen();
    const read = readHero('Kanha');

    request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent);
    await expect(read).resolves.toBeNull();
    request.onsuccess?.(new Event('success'));

    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations)(
    'gives up on a %s whose request never settles, and closes the connection',
    async (_name, operation, outcome) => {
      const never = vi.fn(() => ({}));
      const transaction = IDBDatabase.prototype.transaction;
      vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
        // The upgrade that creates the store on first open is left alone.
        if ((args[1] as string) === 'versionchange') return transaction.apply(this, args);
        return { objectStore: () => ({ get: never, put: never }) } as never;
      });
      const close = vi.spyOn(IDBDatabase.prototype, 'close');
      const state = track(operation());
      for (let turn = 0; turn < 200 && never.mock.calls.length === 0; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(never).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(state.promise).resolves.toBe(outcome);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );
});
