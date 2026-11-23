import { useMatches } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';

const KEY = 'pixdex.phoneColumns';

/** 1 or 2 photo columns on phones (below the `xs` breakpoint), remembered per browser. */
export function usePhoneColumns(): [1 | 2, () => void] {
  const [stored, setStored] = useLocalStorage<number>({ key: KEY, defaultValue: 2, getInitialValueInEffect: false });
  const columns: 1 | 2 = stored === 1 ? 1 : 2;
  return [columns, () => setStored(columns === 1 ? 2 : 1)];
}

/** Photo grid columns: the phone choice below 576px, then 3 and 4 (4 divides the 12, 24 and 48 page sizes). */
export function usePhotoColumns(): number {
  const [phone] = usePhoneColumns();
  // Read the media query on the first render, not in an effect, so a wide screen never flashes the phone layout.
  return useMatches({ base: phone, xs: 3, md: 4 }, { getInitialValueInEffect: false });
}
