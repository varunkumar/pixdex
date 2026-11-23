import { useMatches } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';

const KEY = 'pixdex.phoneColumns';

/** 1 or 2 photo columns on phones (below the `xs` breakpoint), remembered per browser. */
export function usePhoneColumns(): [1 | 2, () => void] {
  const [stored, setStored] = useLocalStorage<number>({ key: KEY, defaultValue: 2, getInitialValueInEffect: false });
  const columns: 1 | 2 = stored === 1 ? 1 : 2;
  return [columns, () => setStored(columns === 1 ? 2 : 1)];
}

/** Photo grid columns: the phone choice below 576px, then 3, 4 and 5 columns. */
export function usePhotoColumns(): number {
  const [phone] = usePhoneColumns();
  // Read the media query on the first render, not in an effect, so a wide screen never flashes the phone layout.
  return useMatches({ base: phone, xs: 3, md: 4, xl: 5 }, { getInitialValueInEffect: false });
}

/** Album tile columns: always at least 2, then 3, 4 and 5 (no 1 column option). */
export function useAlbumColumns(): number {
  return useMatches({ base: 2, xs: 3, md: 4, xl: 5 }, { getInitialValueInEffect: false });
}
