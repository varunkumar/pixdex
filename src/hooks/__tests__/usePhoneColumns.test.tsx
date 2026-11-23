import { MantineProvider } from '@mantine/core';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { theme } from '../../theme';
import { useAlbumColumns, usePhotoColumns } from '../usePhoneColumns';

const Probe = () => <span>cols:{usePhotoColumns()}</span>;
const AlbumProbe = () => <span>cols:{useAlbumColumns()}</span>;

describe('usePhotoColumns', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  it('uses the wide-screen column count on the very first render (no phone layout flash)', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const html = renderToString(
      <MantineProvider theme={theme} env="test">
        <Probe />
      </MantineProvider>
    );
    expect(html).toContain('cols:<!-- -->5');
  });

  it('shows albums in a single column on a phone and 3 to 5 columns above', () => {
    const stub = (matches: boolean) =>
      (window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })) as unknown as typeof window.matchMedia);
    const html = () =>
      renderToString(
        <MantineProvider theme={theme} env="test">
          <AlbumProbe />
        </MantineProvider>
      );
    stub(false);
    expect(html()).toContain('cols:<!-- -->1');
    stub(true);
    expect(html()).toContain('cols:<!-- -->5');
  });
});
