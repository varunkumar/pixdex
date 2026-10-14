import { useEffect, useState } from 'react';

export type PrefetchStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Preload an image into the browser cache and report how it went. */
export function usePrefetchImage(url: string | null): PrefetchStatus {
  const [loaded, setLoaded] = useState<{ url: string; status: 'ready' | 'error' } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setLoaded({ url, status: 'ready' });
    };
    img.onerror = () => {
      if (!cancelled) setLoaded({ url, status: 'error' });
    };
    img.src = url;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [url]);

  if (!url) return 'idle';
  return loaded?.url === url ? loaded.status : 'loading';
}
