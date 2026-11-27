import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHero } from '../../services/heroImage';
import { theme } from '../../theme';
import AlbumHero from '../AlbumHero';

vi.mock('../../services/heroImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/heroImage')>()),
  loadHero: vi.fn(),
}));

const HASH = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const IMAGE = new Blob(['first'], { type: 'image/jpeg' });
const OTHER_IMAGE = new Blob(['second'], { type: 'image/jpeg' });
const PROPS: ComponentProps<typeof AlbumHero> = {
  name: 'Kanha',
  photoCount: 128,
  coverPhotoId: 'ph1',
  coverThumbnailUrl: `/thumbnails/${HASH}`,
};

/** One query client for the whole test, so a rerender keeps the cache (like the app). */
function renderHero(props: Partial<ComponentProps<typeof AlbumHero>> = {}) {
  const client = new QueryClient();
  let current = props;
  let visible = true;
  const tree = () => <Providers client={client}>{visible && <AlbumHero {...PROPS} {...current} />}</Providers>;
  const utils = render(tree());
  return {
    ...utils,
    update: (next: Partial<ComponentProps<typeof AlbumHero>>) => {
      current = next;
      utils.rerender(tree());
    },
    /** Mounts or unmounts the banner alone, keeping the query client (leaving and revisiting the page). */
    show: (on: boolean) => {
      visible = on;
      utils.rerender(tree());
    },
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
const findSharp = () => screen.findByRole('img', { name: 'Cover photo of Kanha' });

const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const { createObjectURL: realCreate, revokeObjectURL: realRevoke } = URL;

beforeEach(() => {
  vi.mocked(loadHero).mockReset().mockReturnValue(new Promise(() => {}));
  let made = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:hero-${++made}`);
  revokeObjectURL.mockReset();
  // jsdom has no object URLs.
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  Object.assign(URL, { createObjectURL: realCreate, revokeObjectURL: realRevoke });
});

/** The URLs made and not yet revoked. */
const liveUrls = () => {
  const revoked = new Set(revokeObjectURL.mock.calls.map(([url]) => url));
  return createObjectURL.mock.results.map((r) => r.value as string).filter((url) => !revoked.has(url));
};

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

  it('shows the image through an object URL once it resolves', async () => {
    vi.mocked(loadHero).mockResolvedValue(IMAGE);
    renderHero();
    expect(await findSharp()).toHaveAttribute('src', 'blob:hero-1');
    expect(createObjectURL).toHaveBeenCalledWith(IMAGE);
    expect(liveUrls()).toEqual(['blob:hero-1']);
  });

  it('revokes the object URL when it unmounts', async () => {
    vi.mocked(loadHero).mockResolvedValue(IMAGE);
    const { unmount } = renderHero();
    await findSharp();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hero-1');
    expect(liveUrls()).toEqual([]);
  });

  it('keeps the blurred thumbnail, with no error text, when there is no hero', async () => {
    vi.mocked(loadHero).mockResolvedValue(null);
    const { container } = renderHero();
    await waitFor(() => expect(loadHero).toHaveBeenCalled());
    await expect(vi.mocked(loadHero).mock.results[0].value).resolves.toBeNull();
    expect(sharp()).not.toBeInTheDocument();
    expect(blurred(container)).toBeInTheDocument();
    expect(screen.queryByText(/error|could not|failed/i)).not.toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('asks for the hero once while it stays on screen', async () => {
    vi.mocked(loadHero).mockResolvedValue(null);
    const { update } = renderHero();
    await waitFor(() => expect(loadHero).toHaveBeenCalledWith('Kanha', HASH, 'ph1'));
    update({ photoCount: 129 });
    expect(await screen.findByText('129 photos')).toBeInTheDocument();
    expect(loadHero).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next visit, with the same query client', async () => {
    vi.mocked(loadHero).mockResolvedValueOnce(null).mockResolvedValue(IMAGE);
    const { show } = renderHero();
    await waitFor(() => expect(loadHero).toHaveBeenCalledTimes(1));
    await expect(vi.mocked(loadHero).mock.results[0].value).resolves.toBeNull();
    show(false);
    // Leaving the page and coming back are separate tasks; the unused query is dropped in between.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    show(true);
    expect(await findSharp()).toBeInTheDocument();
    expect(loadHero).toHaveBeenCalledTimes(2);
  });

  it('never shows the old hero after the cover changes, revokes it and loads the new one', async () => {
    vi.mocked(loadHero).mockImplementation((_album, hash) =>
      hash === HASH ? Promise.resolve(IMAGE) : new Promise(() => {})
    );
    const { container, update } = renderHero();
    await findSharp();
    update({ coverPhotoId: 'ph2', coverThumbnailUrl: `/thumbnails/${OTHER}` });
    expect(sharp()).not.toBeInTheDocument();
    expect(liveUrls()).toEqual([]);
    expect(blurred(container)).toHaveAttribute('src', `/api/thumbnails/${OTHER}`);
    await waitFor(() => expect(loadHero).toHaveBeenLastCalledWith('Kanha', OTHER, 'ph2'));
  });

  it('hides a hero that fails to load, leaving the blurred thumbnail', async () => {
    vi.mocked(loadHero).mockResolvedValue(IMAGE);
    const { container, update } = renderHero();
    fireEvent.error(await findSharp());
    expect(container.querySelector('img.pdx-hero-img')).not.toBeInTheDocument();
    expect(blurred(container)).toBeInTheDocument();
    expect(liveUrls()).toEqual([]);
    update({ photoCount: 129 });
    expect(await screen.findByText('129 photos')).toBeInTheDocument();
    expect(sharp()).not.toBeInTheDocument();
  });

  it("shows a new cover's hero after an earlier one failed to load", async () => {
    vi.mocked(loadHero).mockImplementation((_album, hash) => Promise.resolve(hash === HASH ? IMAGE : OTHER_IMAGE));
    const { update } = renderHero();
    fireEvent.error(await findSharp());
    update({ coverPhotoId: 'ph2', coverThumbnailUrl: `/thumbnails/${OTHER}` });
    expect(await findSharp()).toHaveAttribute('src', 'blob:hero-2');
    expect(createObjectURL).toHaveBeenLastCalledWith(OTHER_IMAGE);
  });
});
