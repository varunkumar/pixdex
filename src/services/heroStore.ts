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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Throws, rejecting the promise, when IndexedDB is missing or blocked.
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'album' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs one request in its own transaction and resolves with its result once the transaction commits. */
async function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      // A full disk shows up here, as an abort, after the request itself has succeeded.
      transaction.onabort = () => reject(transaction.error);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
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
