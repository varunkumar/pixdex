import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import Search from '../Search';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    searchPage: vi.fn(),
    getAlbums: vi.fn(),
    getPeople: vi.fn(),
    getKnownPeople: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));

vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

const page = (n: number) =>
  Array.from({ length: n }, (_, i) => makePhoto({ id: `p${i}`, description: `Photo number ${i}.` }));

async function typeInPeople(text: string) {
  const input = (await screen.findAllByLabelText('People'))[0];
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: text } });
}

describe('Search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha', 'Kaziranga']);
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: page(10), total: 56 });
    vi.mocked(workerApiClient.getKnownPeople).mockResolvedValue([
      { id: 'ms', name: 'MS Dhoni', aliases: ['Mahendra Singh Dhoni'], photoCount: 4 },
    ]);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'a1', name: 'Asha', faceCount: 3, photoCount: 3, canEdit: true, cover: null },
      { id: 'b2', name: 'Ravi', faceCount: 2, photoCount: 2, canEdit: true, cover: null },
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

  it('hides the control when nobody is named and no known person is present', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
    vi.mocked(workerApiClient.getKnownPeople).mockResolvedValue([]);
    renderWithProviders(<Search />, { route: '/search?q=lion' });
    await screen.findByLabelText('Select photo album');
    expect(screen.queryByText('People')).not.toBeInTheDocument();
  });

  describe('date controls', () => {
    afterEach(() => vi.useRealTimers());

    const freezeDate = () => vi.useFakeTimers({ toFake: ['Date'], now: new Date(2025, 5, 15, 12) });

    it('passes from and to from the URL to the request and shows the range', async () => {
      renderWithProviders(<Search />, { route: '/search?from=2025-06-01&to=2025-06-30' });
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith({
          q: '',
          album: '',
          limit: 12,
          offset: 0,
          from: '2025-06-01',
          to: '2025-06-30',
        })
      );
      expect(screen.getByRole('button', { name: 'Dates' })).toHaveTextContent('1 Jun 2025');
      expect(screen.getByRole('button', { name: 'Dates' })).toHaveTextContent('30 Jun 2025');
    });

    it('the This month chip sets from and to in the URL', async () => {
      freezeDate();
      const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion&page=2']);
      fireEvent.click(await screen.findByLabelText('This month'));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion&from=2025-06-01&to=2025-06-30'));
    });

    it('On this day sets onThisDay and clears the range, and a range clears it back', async () => {
      freezeDate();
      const { router } = renderWithRouter(
        [{ path: '/search', element: <Search /> }],
        ['/search?from=2025-06-01&to=2025-06-30']
      );
      fireEvent.click(await screen.findByLabelText('On this day'));
      await waitFor(() => expect(router.state.location.search).toBe('?onThisDay=06-15'));
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ onThisDay: '06-15' }))
      );

      fireEvent.click(screen.getByLabelText('This year'));
      await waitFor(() => expect(router.state.location.search).toBe('?from=2025-01-01&to=2025-12-31'));
    });

    it('clicking an active chip turns it off', async () => {
      const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?onThisDay=06-15']);
      fireEvent.click(await screen.findByLabelText('On this day'));
      await waitFor(() => expect(router.state.location.search).toBe(''));
    });

    it('submitting a typed date writes q, from and to together', async () => {
      const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?page=3']);
      const input = await screen.findByPlaceholderText('Search photos...');
      fireEvent.change(input, { target: { value: 'june 2025 beach' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(router.state.location.search).toBe('?q=beach&from=2025-06-01&to=2025-06-30'));
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'beach', from: '2025-06-01', to: '2025-06-30' })
        )
      );
    });

    it('a date range alone triggers a search', async () => {
      renderWithProviders(<Search />, { route: '/search?from=2025-01-01&to=2025-12-31' });
      await waitFor(() => expect(workerApiClient.searchPage).toHaveBeenCalled());
      expect(screen.queryByText(/enter a search term/i)).not.toBeInTheDocument();
    });

    it('on this day alone triggers a search', async () => {
      renderWithProviders(<Search />, { route: '/search?onThisDay=06-15' });
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ onThisDay: '06-15' }))
      );
    });

    it('picking two different days writes a multi-day range, and nothing is written after the first click', async () => {
      freezeDate();
      const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion']);
      fireEvent.click(await screen.findByRole('button', { name: 'Dates' }));
      vi.mocked(workerApiClient.searchPage).mockClear();

      fireEvent.click(await screen.findByRole('button', { name: /10 June 2025/ }));
      expect(router.state.location.search).toBe('?q=lion');
      expect(workerApiClient.searchPage).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole('button', { name: /20 June 2025/ }));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion&from=2025-06-10&to=2025-06-20'));
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(
          expect.objectContaining({ from: '2025-06-10', to: '2025-06-20' })
        )
      );
    });

    it('clearing the picker removes both params', async () => {
      const { router } = renderWithRouter(
        [{ path: '/search', element: <Search /> }],
        ['/search?q=lion&from=2025-06-01&to=2025-06-30']
      );
      fireEvent.click(await screen.findByLabelText('Clear dates'));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion'));
    });
  });

  it('still shows the People box when only known people exist', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
    renderWithProviders(<Search />, { route: '/search?q=lion' });
    expect((await screen.findAllByLabelText('People'))[0]).toBeInTheDocument();
  });

  it('picking a known person puts known in the URL, resets the page and sends known', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion&page=2']);
    await typeInPeople('dho');
    fireEvent.click(await screen.findByRole('option', { name: /MS Dhoni/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?q=lion&known=ms'));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ known: ['ms'] }))
    );
  });

  it('a known-only URL searches without a term', async () => {
    renderWithProviders(<Search />, { route: '/search?known=ms' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ known: ['ms'] }))
    );
    expect(await screen.findByText('MS Dhoni')).toBeInTheDocument();
  });

  it('an old people-only URL does not send known', async () => {
    renderWithProviders(<Search />, { route: '/search?people=a1' });
    await waitFor(() => expect(workerApiClient.searchPage).toHaveBeenCalled());
    expect(vi.mocked(workerApiClient.searchPage).mock.calls[0][0]).not.toHaveProperty('known');
  });
});
