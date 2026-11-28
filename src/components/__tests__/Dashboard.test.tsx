import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import Dashboard from '../Dashboard';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getAlbumsPage: vi.fn(),
    searchPage: vi.fn(),
    getInsights: vi.fn(async () => ({ day: '2026-11-28', facts: [] })),
    getOnThisDay: vi.fn(async () => ({ date: '2026-11-28', years: [] })),
    thumbnailUrl: vi.fn(() => '/api/thumbnails/h1'),
  },
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

  it('links each count to its page, with no link cards and no indexing controls', async () => {
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('2')).toBeInTheDocument(); // album count
    expect(await screen.findByText('57')).toBeInTheDocument(); // total photos
    expect(await screen.findByRole('img', { name: /leopard in a tree/i })).toHaveAttribute(
      'src',
      '/api/thumbnails/h1'
    );
    expect(screen.getByRole('link', { name: /photos 57/i })).toHaveAttribute('href', '/search');
    expect(screen.getByRole('link', { name: /albums 2/i })).toHaveAttribute('href', '/albums');
    for (const name of ['Search', 'Albums', 'Daily pick']) expect(screen.queryByRole('link', { name })).toBeNull();
    expect(screen.queryByRole('button', { name: /index photos/i })).not.toBeInTheDocument();
  });

  it('shows a dash for each count until it has loaded', () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockReturnValue(new Promise(() => {}));
    vi.mocked(workerApiClient.searchPage).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Dashboard />);
    expect(screen.getAllByText('-')).toHaveLength(2);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('loads the first four recent photos at once and the rest as they come into view', async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({
      total: 5,
      results: ['a', 'b', 'c', 'd', 'e'].map((id) => makePhoto({ id })),
    });
    renderWithProviders(<Dashboard />);
    const images = await screen.findAllByRole('img');
    expect(images.map((i) => i.getAttribute('loading'))).toEqual([null, null, null, null, 'lazy']);
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
