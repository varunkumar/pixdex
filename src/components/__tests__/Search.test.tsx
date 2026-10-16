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
    getPeople: vi.fn(),
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
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'a1', name: 'Asha', faceCount: 3, photoCount: 3, cover: null },
      { id: 'b2', name: 'Ravi', faceCount: 2, photoCount: 2, cover: null },
    ]);
  });

  it('sorts by rating when asked in the URL and leaves relevance as the default', async () => {
    renderWithProviders(<Search />, { route: '/search?q=eagle&sort=rating' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ q: 'eagle', sort: 'rating' }))
    );
    expect(screen.getByLabelText('Sort results')).toHaveValue('Best rated');
  });

  it('runs from the URL on load and fills the form from it', async () => {
    renderWithProviders(<Search />, { route: '/search?q=big+cat&album=Kanha&page=2&size=24' });

    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({
        q: 'big cat',
        album: 'Kanha',
        limit: 24,
        offset: 24,
      })
    );
    expect(screen.getByPlaceholderText('Search photos...')).toHaveValue('big cat');
    expect(await screen.findByText('Photo number 0.')).toBeInTheDocument();
    expect(screen.getByText('Showing 25-48 of 56')).toBeInTheDocument();
  });

  it('does not search and shows a prompt when there is no query or album', async () => {
    renderWithProviders(<Search />, { route: '/search' });
    expect(await screen.findByText(/enter a search term or pick an album/i)).toBeInTheDocument();
    expect(workerApiClient.searchPage).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only query as empty', async () => {
    renderWithProviders(<Search />, { route: '/search?q=%20%20' });
    expect(await screen.findByText(/enter a search term or pick an album/i)).toBeInTheDocument();
    expect(workerApiClient.searchPage).not.toHaveBeenCalled();
  });

  it('searches by album alone', async () => {
    renderWithProviders(<Search />, { route: '/search?album=Kanha' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({ q: '', album: 'Kanha', limit: 12, offset: 0 })
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

  it('selecting two people puts both ids in the URL and the request', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion&page=2']);
    const input = await screen.findByPlaceholderText('Anyone');
    fireEvent.click(input);
    fireEvent.click(await screen.findByRole('option', { name: 'Asha' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Ravi' }));

    await waitFor(() => expect(router.state.location.search).toBe('?q=lion&people=a1%2Cb2'));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ people: ['a1', 'b2'] }))
    );
  });

  it('people filter is restored from the URL and searches without a term', async () => {
    renderWithProviders(<Search />, { route: '/search?people=a1,b2' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ people: ['a1', 'b2'] }))
    );
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    expect(screen.getByText('Ravi')).toBeInTheDocument();
  });

  it('clearing the filter removes the param', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion&people=a1']);
    await screen.findByText('Asha');
    fireEvent.keyDown(screen.getAllByLabelText('People')[0], { key: 'Backspace' });
    await waitFor(() => expect(router.state.location.search).toBe('?q=lion'));
  });

  it('hides the control when nobody is named', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
    renderWithProviders(<Search />, { route: '/search?q=lion' });
    await screen.findByLabelText('Select photo album');
    expect(screen.queryByText('People')).not.toBeInTheDocument();
  });
});
