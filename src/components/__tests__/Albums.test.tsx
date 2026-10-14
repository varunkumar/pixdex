import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import Albums from '../Albums';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getAlbumsPage: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => (p.thumbnailUrl ? `/api${p.thumbnailUrl}` : '')),
  },
}));

const album = (name: string, over = {}) => ({
  name,
  photoCount: 3,
  coverPhotoId: 'c1',
  coverThumbnailUrl: '/thumbnails/h1',
  latestDate: '2026-03-01T10:00:00.000Z',
  ...over,
});

describe('Albums', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [album('Kanha 2026'), album('A/B ? #1 & Ünï', { coverThumbnailUrl: null, latestDate: null })],
      total: 30,
    });
  });

  it('requests the first page of 12 and shows cover, name and count', async () => {
    renderWithProviders(<Albums />, { route: '/albums' });
    expect(await screen.findByText('Kanha 2026')).toBeInTheDocument();
    expect(workerApiClient.getAlbumsPage).toHaveBeenCalledWith({ limit: 12, offset: 0 });
    expect(screen.getAllByText(/3 photos/).length).toBeGreaterThan(0);
    const cover = screen.getByRole('img', { name: /kanha 2026/i });
    expect(cover).toHaveAttribute('src', '/api/thumbnails/h1');
    // The whole cover photo is shown, never cropped.
    expect(cover.getAttribute('style')).toContain('--image-object-fit: contain');
    expect(screen.getByText('Showing 1-12 of 30')).toBeInTheDocument();
  });

  it('links each album to its own page with the name encoded', async () => {
    renderWithProviders(<Albums />, { route: '/albums' });
    const link = await screen.findByRole('link', { name: /kanha 2026/i });
    expect(link).toHaveAttribute('href', '/albums/Kanha%202026');
    const odd = screen.getByRole('link', { name: /A\/B \? #1 & Ünï/ });
    expect(odd).toHaveAttribute('href', `/albums/${encodeURIComponent('A/B ? #1 & Ünï')}`);
  });

  it('renders an album with no cover and no date without crashing', async () => {
    renderWithProviders(<Albums />, { route: '/albums' });
    expect(await screen.findByText('A/B ? #1 & Ünï')).toBeInTheDocument();
  });

  it('pages through the URL', async () => {
    const { router } = renderWithRouter([{ path: '/albums', element: <Albums /> }], ['/albums']);
    fireEvent.click(await screen.findByRole('button', { name: '2' }));
    await waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    await waitFor(() =>
      expect(workerApiClient.getAlbumsPage).toHaveBeenLastCalledWith({ limit: 12, offset: 12 })
    );
  });

  it('shows an empty state for an empty library', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({ albums: [], total: 0 });
    renderWithProviders(<Albums />, { route: '/albums' });
    expect(await screen.findByText(/no albums yet/i)).toBeInTheDocument();
  });
});
