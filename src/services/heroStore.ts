// The browser's copy of each album's cover original, one IndexedDB record per album. The store is only a
// cache: it may be missing, blocked, full or cleared at any time, so nothing here rejects.

export type HeroRecord = {
  album: string;
  contentHash: string;
  /** `unavailable` is tried again on the next visit; `undecodable` is not. */
  status: 'ready' | 'unavailable' | 'undecodable';
  image?: Blob;
  updatedAt: number;
};

const DATABASE = 'pixdex';
const STORE = 'heroes';
// IndexedDB can leave a request unanswered; the page must not wait on it.
const TIMEOUT_MS = 3000;

/**
 * Opens the store, runs one request in its own transaction and resolves with its result once the transaction
 * commits. Rejects on failure, a blocked open or no outcome within the time limit.
 */
function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let database: IDBDatabase | undefined;
    let settled = false;
    /** True for the first outcome only. Closing lets a transaction still running finish first. */
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      database?.close();
      return true;
    };
    const fail = (error: unknown) => {
      if (settle()) reject(error);
    };
    const timer = setTimeout(() => fail(new Error('IndexedDB timed out')), TIMEOUT_MS);

    try {
      // Throws when IndexedDB is missing or blocked.
      const open = indexedDB.open(DATABASE, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'album' });
      open.onerror = () => fail(open.error);
      open.onblocked = () => fail(new Error('IndexedDB is blocked'));
      open.onsuccess = () => {
        // Too late: nobody is waiting for this connection.
        if (settled) return open.result.close();
        database = open.result;
        try {
          const transaction = database.transaction(STORE, mode);
          // A full disk shows up here, as an abort, after the request itself has succeeded.
          transaction.onabort = () => fail(transaction.error);
          const request = run(transaction.objectStore(STORE));
          transaction.oncomplete = () => {
            if (settle()) resolve(request.result);
          };
        } catch (error) {
          fail(error);
        }
      };
    } catch (error) {
      fail(error);
    }
  });
}

/** The album's record, or null when there is none or the store cannot be read. */
export async function readHero(album: string): Promise<HeroRecord | null> {
  try {
    return (await inStore<HeroRecord | undefined>('readonly', (store) => store.get(album))) ?? null;
  } catch {
    return null;
  }
}

/** Replaces the album's record. Does nothing when the store cannot be written. */
export async function writeHero(record: HeroRecord): Promise<void> {
  try {
    await inStore('readwrite', (store) => store.put(record));
  } catch {
    // The image is fetched again on the next visit.
  }
}

/**
 * Marks this cover's stored copy as unavailable, dropping an image that will not show, so a later visit fetches
 * it again. Another cover's record is left alone: the check and the write share one transaction.
 */
export async function markHeroUnavailable(album: string, contentHash: string): Promise<void> {
  try {
    await inStore('readwrite', (store) => {
      const read = store.get(album);
      read.onsuccess = () => {
        if ((read.result as HeroRecord | undefined)?.contentHash !== contentHash) return;
        const record: HeroRecord = { album, contentHash, status: 'unavailable', updatedAt: Date.now() };
        store.put(record);
      };
      return read;
    });
  } catch {
    // The same copy is tried again on the next visit.
  }
}
