import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
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
    fireEvent.click(await screen.findByRole('combobox', { name: /sort photos/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'Alphabetical', hidden: true }));
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
    fireEvent.click(await screen.findByRole('button', { name: /set as cover/i }));
    await waitFor(() => expect(workerApiClient.setAlbumCover).toHaveBeenCalledWith('Kanha', makePhoto().id));
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
    expect(await screen.findByText('Cover')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Set as cover' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
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
    expect(await screen.findByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByLabelText('a@example.com')).toBeInTheDocument();
  });
});
