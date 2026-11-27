import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { loadHero } from '../../services/heroImage';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import AlbumPhotos from '../AlbumPhotos';
import Albums from '../Albums';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    searchPage: vi.fn(),
    getAlbumsPage: vi.fn(),
    getAlbumContents: vi.fn(),
    setAlbumCover: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));
vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));
vi.mock('../../services/heroImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/heroImage')>()),
  loadHero: vi.fn(),
}));

const FACE = {
  id: 'f1',
  photoId: 'ph1',
  thumbnailUrl: '/thumbnails/ph1',
  bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
  detScore: 0.9,
  personId: null,
  personName: null,
  status: 'unassigned' as const,
  matchScore: null,
};
const CONTENTS = {
  people: [
    { id: 'p1', name: 'Asha', canEdit: true, photoCount: 3, cover: FACE },
    { id: 'p2', name: null, canEdit: true, photoCount: 1, cover: null },
  ],
  known: [{ id: 'Q1', name: 'Some Star', photoCount: 2, cover: FACE }],
  species: [
    { scientific: 'Elephas maximus', common: 'Asian Elephant', photoCount: 4, coverPhotoId: 'ph1', thumbnailUrl: '/thumbnails/ph1' },
  ],
};

function renderAlbum(route = '/albums/Kanha') {
  return renderWithRouter(
    [
      {
        path: '/albums/:name',
        element: <AlbumPhotos />,
      },
    ],
    [route]
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [makePhoto()], total: 1 });
  vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
    albums: [
      {
        name: 'Kanha',
        photoCount: 1,
        coverPhotoId: 'other',
        coverThumbnailUrl: null,
        latestDate: null,
        role: 'owner',
      },
    ],
    total: 1,
  });
  vi.mocked(workerApiClient.setAlbumCover).mockResolvedValue();
  vi.mocked(workerApiClient.getAlbumContents).mockResolvedValue(CONTENTS);
  vi.mocked(loadHero).mockResolvedValue(null);
});

describe('AlbumPhotos tabs', () => {
  it('shows People and Species tabs with counts once contents load', async () => {
    renderAlbum();
    expect(await screen.findByRole('tab', { name: /People/ })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /Species/ })).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: /Photos/ })).toBeInTheDocument();
    expect(workerApiClient.getAlbumContents).toHaveBeenCalledWith('Kanha');
  });

  it('hides both tabs for empty contents', async () => {
    vi.mocked(workerApiClient.getAlbumContents).mockResolvedValue({ people: [], known: [], species: [] });
    renderAlbum();
    expect((await screen.findAllByText('A leopard in a tree.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(workerApiClient.getAlbumContents).toHaveBeenCalled());
    expect(screen.queryByRole('tab', { name: /People/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Species/ })).not.toBeInTheDocument();
  });

  it('shows one line on a contents error and keeps the photos', async () => {
    vi.mocked(workerApiClient.getAlbumContents).mockRejectedValue(new Error('boom'));
    renderAlbum();
    expect(await screen.findByText(/could not load people and species/i)).toBeInTheDocument();
    expect(screen.getAllByText('A leopard in a tree.').length).toBeGreaterThan(0);
  });

  it('filters by a person tile, shows the chip and the total, and clearing drops the param', async () => {
    const { router } = renderAlbum('/albums/Kanha?page=2&tab=people');
    fireEvent.click(await screen.findByRole('button', { name: /^Asha/ }));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenLastCalledWith({
        album: 'Kanha',
        people: ['p1'],
        sort: 'date',
        limit: 12,
        offset: 0,
      })
    );
    expect(router.state.location.search).toBe('?people=p1');
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenLastCalledWith({ album: 'Kanha', sort: 'date', limit: 12, offset: 0 })
    );
  });

  it('uses known for a known tile and species for a species tile', async () => {
    renderAlbum('/albums/Kanha?tab=people');
    fireEvent.click(await screen.findByRole('button', { name: /^Some Star/ }));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenLastCalledWith(expect.objectContaining({ known: ['Q1'] }))
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    fireEvent.click(await screen.findByRole('tab', { name: /Species/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Asian Elephant/ }));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ species: 'Elephas maximus' })
      )
    );
  });

  it('applies only the first filter kind from the URL', async () => {
    renderAlbum('/albums/Kanha?people=p1&species=x');
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({
        album: 'Kanha',
        people: ['p1'],
        sort: 'date',
        limit: 12,
        offset: 0,
      })
    );
  });

  it('deep link by species shows the scientific name chip before contents load', async () => {
    vi.mocked(workerApiClient.getAlbumContents).mockReturnValue(new Promise(() => {}));
    renderAlbum('/albums/Kanha?species=Elephas%20maximus');
    expect(await screen.findByText('Elephas maximus')).toBeInTheDocument();
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ species: 'Elephas maximus' }))
    );
  });

  it('an unknown species deep link shows the chip and the filtered empty message, no error', async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
    renderAlbum('/albums/Kanha?species=Nope');
    expect(await screen.findByText('Nope')).toBeInTheDocument();
    expect(await screen.findByText('No photos in this album match this filter.')).toBeInTheDocument();
    expect(screen.queryByText('This album has no photos.')).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it('keeps the plain empty message when no filter is active', async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
    renderAlbum();
    expect(await screen.findByText('This album has no photos.')).toBeInTheDocument();
  });

  it('links an own person chip to the person page, once contents load', async () => {
    renderAlbum('/albums/Kanha?people=p1');
    expect(await screen.findByRole('link', { name: 'View all photos of Asha' })).toHaveAttribute('href', '/people/p1');
  });

  it('shows no person link before contents load', async () => {
    vi.mocked(workerApiClient.getAlbumContents).mockReturnValue(new Promise(() => {}));
    renderAlbum('/albums/Kanha?people=p1');
    expect(await screen.findByText('Person')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view all photos/i })).not.toBeInTheDocument();
  });

  it('shows no person link for a person the user does not own, nor for known or species', async () => {
    vi.mocked(workerApiClient.getAlbumContents).mockResolvedValue({
      ...CONTENTS,
      people: [{ id: 'p9', name: 'Theirs', canEdit: false, photoCount: 1, cover: null }],
    });
    const { router } = renderAlbum('/albums/Kanha?people=p9');
    expect(await screen.findByText('Theirs')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view all photos/i })).not.toBeInTheDocument();
    await router.navigate('/albums/Kanha?known=Q1');
    expect(await screen.findByText('Some Star')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view all photos/i })).not.toBeInTheDocument();
    await router.navigate('/albums/Kanha?species=Elephas%20maximus');
    expect(await screen.findByText('Asian Elephant')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view all photos/i })).not.toBeInTheDocument();
  });

  it('labels a nameless person Unnamed', async () => {
    renderAlbum('/albums/Kanha?tab=people');
    expect(await screen.findByRole('button', { name: /^Unnamed/ })).toBeInTheDocument();
  });
});

describe('AlbumPhotos', () => {
  it('lists the album photos by date using the decoded name from the URL', async () => {
    renderWithProviders(<AlbumPhotos />, {
      route: `/albums/${encodeURIComponent('A/B #1')}`,
      path: '/albums/:name',
    });

    expect(await screen.findByRole('heading', { name: 'A/B #1' })).toBeInTheDocument();
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({
        album: 'A/B #1',
        sort: 'date',
        limit: 12,
        offset: 0,
      })
    );
    expect((await screen.findAllByText('A leopard in a tree.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /all albums/i })).toHaveAttribute('href', '/albums');
  });

  it('sorts photos through the URL', async () => {
    renderWithProviders(<AlbumPhotos />, { route: '/albums/Kanha', path: '/albums/:name' });
    fireEvent.click(await screen.findByRole('button', { name: 'Alphabetical' }));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenLastCalledWith({
        album: 'Kanha',
        sort: 'name',
        limit: 12,
        offset: 0,
      })
    );
  });

  it('sets a photo as the album cover', async () => {
    renderWithProviders(<AlbumPhotos />, { route: '/albums/Kanha', path: '/albums/:name' });
    // Each tile's button names its photo, so a screen reader can tell them apart.
    const buttons = await screen.findAllByRole('button', { name: /^set as cover: /i });
    expect(buttons[0]).toHaveAccessibleName(/leopard in a tree/i);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(workerApiClient.setAlbumCover).toHaveBeenCalledWith('Kanha', makePhoto().id));
  });

  it('reports a failed cover change as a notification', async () => {
    vi.mocked(workerApiClient.setAlbumCover).mockRejectedValue(new Error('Cover exploded'));
    renderAlbum();
    fireEvent.click(await screen.findByRole('button', { name: /^set as cover/i }));
    expect((await screen.findByText('Cover exploded')).closest('.mantine-Notification-root')).not.toBeNull();
  });

  it('marks the current cover photo with a Cover badge instead of a button', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [
        {
          name: 'Kanha',
          photoCount: 1,
          coverPhotoId: makePhoto().id,
          coverThumbnailUrl: null,
          latestDate: null,
          role: 'owner',
        },
      ],
      total: 1,
    });
    renderWithProviders(<AlbumPhotos />, { route: '/albums/Kanha', path: '/albums/:name' });
    const badge = await screen.findByText('Cover');
    expect(badge.closest('.pdx-tile-actions')).toBeNull(); // visible without hover
    expect(screen.queryByRole('button', { name: /set as cover/i })).not.toBeInTheDocument();
  });

  it('returns to the albums listing it came from, keeping its sort', async () => {
    // A total that really has a page 2, so the pagination never clamps the page away (the clamp raced this test).
    const base = await workerApiClient.getAlbumsPage();
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({ ...base, total: 30 });
    renderWithRouter(
      [
        { path: '/albums', element: <Albums /> },
        { path: '/albums/:name', element: <AlbumPhotos /> },
      ],
      ['/albums?sort=rating&page=2']
    );
    fireEvent.click(await screen.findByRole('link', { name: /kanha/i }));
    expect(await screen.findByRole('link', { name: /all albums/i })).toHaveAttribute(
      'href',
      '/albums?sort=rating&page=2'
    );
  });

  it('hides the cover picker and Share button for a shared-with-you album', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [
        {
          name: 'Kanha',
          photoCount: 1,
          coverPhotoId: 'other',
          coverThumbnailUrl: null,
          latestDate: null,
          role: 'viewer',
        },
      ],
      total: 1,
    });
    renderWithProviders(<AlbumPhotos />, { route: '/albums/Kanha', path: '/albums/:name' });
    expect((await screen.findAllByText('A leopard in a tree.')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Shared with you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set as cover/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^share/i })).not.toBeInTheDocument();
  });

  it('shows Share and the sharee avatars to the owner of a shared album', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [
        {
          name: 'Kanha',
          photoCount: 1,
          coverPhotoId: 'other',
          coverThumbnailUrl: null,
          latestDate: null,
          role: 'owner',
          sharedWith: ['a@example.com'],
        },
      ],
      total: 1,
    });
    renderWithProviders(<AlbumPhotos />, { route: '/albums/Kanha', path: '/albums/:name' });
    expect(await screen.findByRole('button', { name: /^share/i })).toBeInTheDocument();
    expect(screen.getByLabelText('a@example.com')).toBeInTheDocument();
  });
});

describe('AlbumPhotos hero', () => {
  const HASH = 'c'.repeat(32);
  const withCover = (role: 'owner' | 'viewer', coverThumbnailUrl: string | null = `/thumbnails/${HASH}`) =>
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [{ name: 'Kanha', photoCount: 128, coverPhotoId: 'cov', coverThumbnailUrl, latestDate: null, role }],
      total: 1,
    });

  it('shows the name and the album photo count once, inside the hero', async () => {
    withCover('owner');
    const { container } = renderAlbum();
    await waitFor(() => expect(container.querySelector('.pdx-hero')).toBeInTheDocument());
    expect((await screen.findAllByText('A leopard in a tree.')).length).toBeGreaterThan(0);
    const headings = screen.getAllByRole('heading', { name: 'Kanha' });
    expect(headings).toHaveLength(1);
    const hero = headings[0].closest<HTMLElement>('.pdx-hero');
    expect(hero).not.toBeNull();
    expect(within(hero!).getByText('128 photos')).toBeInTheDocument();
    // The row's own count (the photo list total is 1) is gone without a filter.
    expect(screen.queryByText('1 photo')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alphabetical' })).toBeInTheDocument();
  });

  it.each(['owner', 'viewer'] as const)('loads the hero for the album cover (%s)', async (role) => {
    withCover(role);
    renderAlbum();
    await waitFor(() => expect(loadHero).toHaveBeenCalledWith('Kanha', HASH, 'cov'));
  });

  it.each([
    ['owner', true],
    ['viewer', false],
  ] as const)('applies the saved framing and offers Reposition to the owner only (%s)', async (role, offered) => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [
        {
          name: 'Kanha',
          photoCount: 128,
          coverPhotoId: 'cov',
          coverThumbnailUrl: `/thumbnails/${HASH}`,
          coverFraming: { x: 20, y: 70, zoom: 1.5 },
          latestDate: null,
          role,
        },
      ],
      total: 1,
    });
    vi.mocked(loadHero).mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }));
    const { createObjectURL, revokeObjectURL } = URL;
    // jsdom has no object URLs.
    Object.assign(URL, { createObjectURL: () => 'blob:hero', revokeObjectURL: () => {} });
    try {
      const { unmount } = renderAlbum();
      const img = await screen.findByRole('img', { name: 'Cover photo of Kanha' });
      expect(img.style.objectPosition).toBe('20% 70%');
      fireEvent.load(img);
      expect(screen.queryByRole('button', { name: 'Reposition' }) !== null).toBe(offered);
      unmount();
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    }
  });

  it('keeps the filtered total in the row while a filter is active', async () => {
    withCover('owner');
    const { container } = renderAlbum('/albums/Kanha?species=Nope');
    await waitFor(() => expect(container.querySelector('.pdx-hero')).toBeInTheDocument());
    const count = await screen.findByText('1 photo');
    expect(count.closest('.pdx-hero')).toBeNull();
    expect(screen.getByText('128 photos').closest('.pdx-hero')).not.toBeNull();
  });

  it('keeps the old header without a cover thumbnail', async () => {
    withCover('owner', null);
    const { container } = renderAlbum();
    expect(await screen.findByRole('button', { name: /^share/i })).toBeInTheDocument();
    expect(await screen.findByText('1 photo')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Kanha' })).toHaveLength(1);
    expect(container.querySelector('.pdx-hero')).toBeNull();
    expect(loadHero).not.toHaveBeenCalled();
  });
});
