import { useCallback, useState } from 'react';

const KEY = 'pixdex.thumbRatios';
const MAX_ENTRIES = 3000;

function read(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Real thumbnail shapes for photos whose stored width and height disagree with their thumbnail (the agent recorded
 * a phone portrait shot's raw landscape size, while its thumbnail is rotated upright). Learned when a thumbnail
 * loads and remembered in this browser, so the next visit lays the tile out correctly from the start.
 */
export function useThumbRatios(): { ratios: Record<string, number>; report: (id: string, ratio: number) => void } {
  const [ratios, setRatios] = useState<Record<string, number>>(read);

  const report = useCallback((id: string, ratio: number) => {
    setRatios((current) => {
      if (current[id] === ratio) return current;
      // Newest last; drop the oldest beyond the cap so the entry never grows without bound.
      const others = Object.entries(current).filter(([key]) => key !== id);
      const next = Object.fromEntries([...others, [id, ratio]].slice(-MAX_ENTRIES));
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private mode or a full quota: the correction still applies for this visit.
      }
      return next;
    });
  }, []);

  return { ratios, report };
}
