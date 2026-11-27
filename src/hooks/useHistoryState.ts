import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import { useLocation } from 'react-router-dom';

const stores = new WeakMap<QueryClient, Map<string, unknown>>();

function storeFor(client: QueryClient) {
  const store = stores.get(client) ?? new Map<string, unknown>();
  stores.set(client, store);
  return store;
}

/**
 * `useState` that belongs to the history entry, so Back and Forward bring it back. A new entry of the same page (a
 * change to the address) keeps the current value; a different `name` starts from `initial`. Browser memory only,
 * lost on a page reload. State that should be shareable belongs in the address instead (`useListParams`).
 */
export function useHistoryState<T>(name: string, initial: T): [T, (next: SetStateAction<T>) => void] {
  const store = storeFor(useQueryClient());
  const { key } = useLocation();
  const id = `${key}:${name}`;
  const read = (fallback: T) => (store.has(id) ? (store.get(id) as T) : fallback);
  const [held, setHeld] = useState(() => ({ id, name, value: read(initial) }));
  // The location changed under a mounted component: adjust during render, before anything is shown.
  if (held.id !== id) setHeld({ id, name, value: read(held.name === name ? held.value : initial) });

  useEffect(() => {
    store.set(held.id, held.value);
  }, [store, held]);

  const set = useCallback(
    (next: SetStateAction<T>) =>
      setHeld((prev) => ({ ...prev, value: next instanceof Function ? next(prev.value) : next })),
    []
  );
  return [held.value, set];
}
