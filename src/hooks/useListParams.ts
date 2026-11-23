import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

// Options for the page size selector; the size actually used is rounded up to whole rows (see `columns` below).
export const PAGE_SIZES = [12, 24, 48] as const;

type Patch = Record<string, string | number | null | undefined>;

/**
 * Pagination state that lives in the URL, so every list page is deep-linkable
 * and back/forward restores it. Invalid or default values never reach the URL.
 */
export function useListParams(defaultSize = 12, sizes: readonly number[] = PAGE_SIZES, columns = 1) {
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();

  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const requested = Number(params.get('size'));
  const option = sizes.includes(requested) ? requested : defaultSize;
  // A grid shows whole rows: round the chosen page size up to a multiple of its column count, so no row is left
  // partly empty (12 on a 5 column screen becomes 15). `option` is what the size selector shows.
  const size = Math.ceil(option / Math.max(1, columns)) * Math.max(1, columns);

  // `update` is stable and always starts from the latest URL, so a memoized caller (e.g. an `onPage`
  // callback) can never rebuild the query from a stale snapshot and drop params such as `sort`.
  const latest = useRef({ params, setParams, state });
  useLayoutEffect(() => {
    latest.current = { params, setParams, state };
  });

  const update = useCallback((patch: Patch, opts: { resetPage?: boolean; replace?: boolean } = {}) => {
    const { params, setParams, state } = latest.current;
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    if (opts.resetPage) next.delete('page');
    if (next.get('page') === '1') next.delete('page');
    if (Number(next.get('size')) === defaultSize) next.delete('size');
    // Keep location.state: pages stash where to go back to (e.g. the albums list page) in it.
    setParams(next, { replace: opts.replace ?? false, state });
  }, [defaultSize]);

  return { params, page, size, option, offset: (page - 1) * size, update };
}
