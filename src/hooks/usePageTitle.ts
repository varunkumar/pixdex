import { useEffect } from 'react';
import { BRAND } from '../theme';

/** Names the browser tab "<page> | PixdeX", or just the brand while the page's name is not known. */
export function usePageTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} | ${BRAND}` : BRAND;
  }, [title]);
}
