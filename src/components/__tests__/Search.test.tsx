import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import Search from '../Search';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    searchPage: vi.fn(),
    getAlbums: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));

vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

const page = (n: number) =>
  Array.from({ length: n }, (_, i) => makePhoto({ id: `p${i}`, description: `Photo number ${i}.` }));

describe('Search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha', 'Kaziranga']);
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: page(10), total: 56 });
  });

  it('runs from the URL on load and fills the form from it', async () => {
    renderWithProviders(<Search />, { route: '/search?q=big+cat&album=Kanha&page=2&size=20' });

    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({
        q: 'big cat',
        album: 'Kanha',
        limit: 20,
        offset: 20,
      })
    );
    expect(screen.getByPlaceholderText('Search photos...')).toHaveValue('big cat');
    expect(await screen.findByText('Photo number 0.')).toBeInTheDocument();
    expect(screen.getByText('Showing 21-40 of 56')).toBeInTheDocument();
  });

  it('lists everything newest first when there are no params', async () => {
    renderWithProviders(<Search />, { route: '/search' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({ q: '', album: '', limit: 10, offset: 0 })
    );
  });

  it('treats a whitespace-only query as empty', async () => {
    renderWithProviders(<Search />, { route: '/search?q=%20%20' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({ q: '', album: '', limit: 10, offset: 0 })
    );
  });

  it('submitting writes q to the URL and resets to page 1', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion&page=3']);

    const input = await screen.findByPlaceholderText('Search photos...');
    fireEvent.change(input, { target: { value: 'leopard' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(router.state.location.search).toBe('?q=leopard'));
  });

  it('back navigation restores the previous query in the form', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion']);

    const input = await screen.findByPlaceholderText('Search photos...');
    fireEvent.change(input, { target: { value: 'leopard' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.search).toBe('?q=leopard'));

    await router.navigate(-1);
    await waitFor(() => expect(screen.getByPlaceholderText('Search photos...')).toHaveValue('lion'));
  });

  it('paging updates the URL', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion']);
    fireEvent.click(await screen.findByRole('button', { name: '2' }));
    await waitFor(() => expect(router.state.location.search).toBe('?q=lion&page=2'));
  });

  it('shows an empty state when nothing matches', async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
    renderWithProviders(<Search />, { route: '/search?q=dragon' });
    expect(await screen.findByText(/no photos match/i)).toBeInTheDocument();
  });

  it('shows the error message when the search fails', async () => {
    vi.mocked(workerApiClient.searchPage).mockRejectedValue(new Error('Request to /search failed: 500'));
    renderWithProviders(<Search />, { route: '/search?q=lion' });
    expect(await screen.findByText('Request to /search failed: 500')).toBeInTheDocument();
  });
});
