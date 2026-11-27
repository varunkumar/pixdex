import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHero } from '../../services/heroImage';
import { theme } from '../../theme';
import AlbumHero from '../AlbumHero';

vi.mock('../../services/heroImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/heroImage')>()),
  loadHero: vi.fn(),
}));

const HASH = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const PROPS: ComponentProps<typeof AlbumHero> = {
  name: 'Kanha',
  photoCount: 128,
  coverPhotoId: 'ph1',
  coverThumbnailUrl: `/thumbnails/${HASH}`,
  canCreate: true,
};

/** One query client for the whole test, so a rerender keeps the cache (like the app). */
function renderHero(props: Partial<ComponentProps<typeof AlbumHero>> = {}) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Providers client={client}>{children}</Providers>
  );
  const utils = render(<AlbumHero {...PROPS} {...props} />, { wrapper });
  return {
    ...utils,
    update: (next: Partial<ComponentProps<typeof AlbumHero>>) => utils.rerender(<AlbumHero {...PROPS} {...next} />),
  };
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  const [queryClient] = useState(client);
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} env="test">
        {children}
      </MantineProvider>
    </QueryClientProvider>
  );
}

const blurred = (container: HTMLElement) => container.querySelector('img.pdx-hero-blur');
const sharp = () => screen.queryByRole('img', { name: 'Cover photo of Kanha' });

beforeEach(() => {
  vi.mocked(loadHero).mockReset().mockReturnValue(new Promise(() => {}));
});

describe('AlbumHero', () => {
  it('shows the blurred thumbnail, the name and the count while the hero loads', () => {
    const { container } = renderHero();
    expect(blurred(container)).toHaveAttribute('src', `/api/thumbnails/${HASH}`);
    expect(screen.getByRole('heading', { name: 'Kanha' })).toBeInTheDocument();
    expect(screen.getByText('128 photos')).toBeInTheDocument();
    expect(sharp()).not.toBeInTheDocument();
  });

  it('says 1 photo for one', () => {
    renderHero({ photoCount: 1 });
    expect(screen.getByText('1 photo')).toBeInTheDocument();
  });

  it('shows the hero image once it resolves', async () => {
    vi.mocked(loadHero).mockResolvedValue(`/api/heroes/${HASH}`);
    renderHero();
    expect(await screen.findByRole('img', { name: 'Cover photo of Kanha' })).toHaveAttribute(
      'src',
      `/api/heroes/${HASH}`
    );
  });

  it('keeps the blurred thumbnail, with no error text, when there is no hero', async () => {
    vi.mocked(loadHero).mockResolvedValue(null);
    const { container } = renderHero();
    await waitFor(() => expect(loadHero).toHaveBeenCalled());
    await expect(vi.mocked(loadHero).mock.results[0].value).resolves.toBeNull();
    expect(sharp()).not.toBeInTheDocument();
    expect(blurred(container)).toBeInTheDocument();
    expect(screen.queryByText(/error|could not|failed/i)).not.toBeInTheDocument();
  });

  it.each([true, false])('asks for the hero once, with canCreate %s', async (canCreate) => {
    vi.mocked(loadHero).mockResolvedValue(null);
    const { update } = renderHero({ canCreate });
    await waitFor(() => expect(loadHero).toHaveBeenCalledWith(HASH, 'ph1', canCreate));
    update({ canCreate, photoCount: 129 });
    expect(await screen.findByText('129 photos')).toBeInTheDocument();
    expect(loadHero).toHaveBeenCalledTimes(1);
  });

  it('never shows the old hero after the cover changes, and loads the new one', async () => {
    vi.mocked(loadHero).mockImplementation((hash) =>
      hash === HASH ? Promise.resolve(`/api/heroes/${HASH}`) : new Promise(() => {})
    );
    const { container, update } = renderHero();
    await screen.findByRole('img', { name: 'Cover photo of Kanha' });
    update({ coverPhotoId: 'ph2', coverThumbnailUrl: `/thumbnails/${OTHER}` });
    expect(sharp()).not.toBeInTheDocument();
    expect(blurred(container)).toHaveAttribute('src', `/api/thumbnails/${OTHER}`);
    await waitFor(() => expect(loadHero).toHaveBeenLastCalledWith(OTHER, 'ph2', true));
  });
});
