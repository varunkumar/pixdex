import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import Dashboard from '../Dashboard';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getAlbumsPage: vi.fn(), searchPage: vi.fn(), thumbnailUrl: vi.fn(() => '/api/thumbnails/h1') },
}));

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({ albums: [], total: 2 });
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({
      total: 57,
      results: [makePhoto({ album: 'Kanha' })],
    });
  });

  it('shows the album count and links to Search/Albums/Daily Pick, with no indexing controls', async () => {
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('2')).toBeInTheDocument(); // album count
    expect(await screen.findByText('57')).toBeInTheDocument(); // total photos
    expect(await screen.findByRole('img', { name: /leopard in a tree/i })).toHaveAttribute(
      'src',
      '/api/thumbnails/h1'
    );
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/search');
    expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '/albums');
    expect(screen.getByRole('link', { name: /daily pick/i })).toHaveAttribute('href', '/daily');
    expect(screen.queryByRole('button', { name: /index photos/i })).not.toBeInTheDocument();
  });

  it('titles the card PixdeX', async () => {
    renderWithProviders(<Dashboard />);
    expect(await screen.findByRole('heading', { name: 'PixdeX' })).toBeInTheDocument();
  });

  it('shows zero counts for an empty library', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({ albums: [], total: 0 });
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
    renderWithProviders(<Dashboard />);
    expect(await screen.findAllByText('0')).toHaveLength(2);
  });
});
