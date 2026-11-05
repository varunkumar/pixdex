import { useSearchParams } from 'react-router-dom';
import type { TimelineZoom } from '../types/api';

export const ZOOMS: readonly TimelineZoom[] = ['day', 'month', 'year'];

interface FilterPatch {
  album?: string;
  people?: string[];
  to?: string;
}

const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

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

  const write = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  };

  const setZoom = (z: TimelineZoom) => write({ zoom: z === 'month' ? null : z });

  const setFilters = (patch: FilterPatch) =>
    write({
      ...(patch.album !== undefined && { album: patch.album }),
      ...(patch.people !== undefined && { people: patch.people.join(',') }),
      ...(patch.to !== undefined && { to: patch.to }),
    });

  /** Start the list at the end of the given `YYYY-MM` month. */
  const jumpTo = (month: string) => {
    const [y, m] = month.split('-').map(Number);
    if (!y || !m || m < 1 || m > 12) return;
    write({ to: `${month}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}` });
  };

  return { zoom, album, people, to, setZoom, setFilters, jumpTo };
}
