// @vitest-environment node
// Node's Blob survives the structured clone fake-indexeddb makes; jsdom's does not.
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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
