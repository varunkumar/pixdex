import { useSearchParams } from 'react-router-dom';

// Multiples of 12 so every grid width (1, 2, 3 or 4 columns) fills its last row.
export const PAGE_SIZES = [12, 24, 48] as const;

type Patch = Record<string, string | number | null | undefined>;

/**
 * Pagination state that lives in the URL, so every list page is deep-linkable
 * and back/forward restores it. Invalid or default values never reach the URL.
 */
export function useListParams(defaultSize = 12, sizes: readonly number[] = PAGE_SIZES) {
  const [params, setParams] = useSearchParams();

  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const requested = Number(params.get('size'));
  const size = sizes.includes(requested) ? requested : defaultSize;

  const update = (patch: Patch, opts: { resetPage?: boolean; replace?: boolean } = {}) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    if (opts.resetPage) next.delete('page');
    if (next.get('page') === '1') next.delete('page');
    if (Number(next.get('size')) === defaultSize) next.delete('size');
    setParams(next, { replace: opts.replace ?? false });
  };

  return { params, page, size, offset: (page - 1) * size, update };
}
