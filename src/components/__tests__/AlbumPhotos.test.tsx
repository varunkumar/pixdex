import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import AlbumPhotos from '../AlbumPhotos';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    searchPage: vi.fn(),
    getAlbumsPage: vi.fn(),
    setAlbumCover: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));
vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

describe('AlbumPhotos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [makePhoto()], total: 1 });
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [{ name: 'Kanha', photoCount: 1, coverPhotoId: 'other', coverThumbnailUrl: null, latestDate: null }],
      total: 1,
    });
    vi.mocked(workerApiClient.setAlbumCover).mockResolvedValue();
  });

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
    expect(await screen.findByText('A leopard in a tree.')).toBeInTheDocument();
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
});
