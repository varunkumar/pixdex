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
  return useMatches({ base: phone, xs: 3, md: 4, xl: 5 });
}
