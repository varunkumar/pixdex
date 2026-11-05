import { useSearchParams } from 'react-router-dom';
import type { TimelineZoom } from '../types/api';

export const ZOOMS: readonly TimelineZoom[] = ['day', 'month', 'year'];

interface FilterPatch {
  album?: string;
  people?: string[];
  to?: string;
}

const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** `YYYY-MM` (or `YYYY-M`) to the `YYYY-MM-DD` of its last day, or null when malformed. */
function endOfMonth(month: string): string | null {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`;
}

/**
 * Timeline view state that lives in the URL, so a zoom level, filters and a jump
 * position are deep-linkable. `zoom` is omitted for the default (`month`).
 */
export function useTimelineParams() {
  const [params, setParams] = useSearchParams();

  const requested = params.get('zoom');
  const zoom: TimelineZoom = ZOOMS.find((z) => z === requested) ?? 'month';
  const album = params.get('album') ?? '';
  const people = (params.get('people') ?? '').split(',').filter(Boolean).slice(0, 5);
  const to = params.get('to') ?? '';

  const write = (patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace });
  };

  /**
   * Change zoom. With `keepMonth`, the list also starts at the end of that month,
   * in the same URL update, so zooming keeps the period being read. That write
   * replaces the history entry, like a jump.
   */
  const setZoom = (z: TimelineZoom, keepMonth?: string) => {
    const zoomValue = z === 'month' ? null : z;
    const end = keepMonth ? endOfMonth(keepMonth) : null;
    if (end) write({ zoom: zoomValue, to: end }, true);
    else write({ zoom: zoomValue });
  };

  const setFilters = (patch: FilterPatch) =>
    write({
      ...(patch.album !== undefined && { album: patch.album }),
      ...(patch.people !== undefined && { people: patch.people.join(',') }),
      ...(patch.to !== undefined && { to: patch.to }),
    });

  /** Start the list at the end of the given `YYYY-MM` month. */
  const jumpTo = (month: string) => {
    const end = endOfMonth(month);
    // Replace, so scrubbing around does not stack a history entry per jump.
    if (end) write({ to: end }, true);
  };

  return { zoom, album, people, to, setZoom, setFilters, jumpTo };
}
