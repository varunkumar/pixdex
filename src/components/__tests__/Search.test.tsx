import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAiSearch, type AiSearchResult, type RankedPhoto } from '../../services/aiSearch/pipeline';
import { expandRequest, getPromptApiStatus } from '../../services/aiSearch/promptApi';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import LegacyAiRedirect from '../LegacyAiRedirect';
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
vi.mock('../../services/aiSearch/promptApi', () => ({ getPromptApiStatus: vi.fn(), expandRequest: vi.fn() }));
vi.mock('../../services/aiSearch/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/aiSearch/pipeline')>()),
  runAiSearch: vi.fn(),
}));
vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

const page = (n: number) =>
  Array.from({ length: n }, (_, i) => makePhoto({ id: `p${i}`, description: `Photo number ${i}.` }));

const routes = [
  { path: '/search', element: <Search /> },
  { path: '/ai-search', element: <LegacyAiRedirect /> },
];
const go = (url: string) => renderWithRouter(routes, [url]);
const box = () => screen.findByRole('combobox', { name: 'Search' });
const urlParams = (router: ReturnType<typeof go>['router']) => new URLSearchParams(router.state.location.search);

const emptyResult: AiSearchResult = { items: [], keywords: [], hiddenPeople: 0 };
const both = { hidePeople: true, leaveRoom: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPromptApiStatus).mockResolvedValue('unsupported');
  vi.mocked(runAiSearch).mockResolvedValue(emptyResult);
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

describe('Search (plain mode)', () => {
  it('sorts by rating when asked in the URL and leaves relevance as the default', async () => {
    renderWithProviders(<Search />, { route: '/search?q=eagle&sort=rating' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ q: 'eagle', sort: 'rating' }))
    );
    expect(screen.getByLabelText('Sort results')).toHaveValue('Best rated');
  });

  it('runs from the URL on load and fills the bar from it', async () => {
    renderWithProviders(<Search />, { route: '/search?q=big+cat&album=Kanha&page=2&size=24' });

    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({
        q: 'big cat',
        album: 'Kanha',
        limit: 24,
        offset: 24,
      })
    );
    expect(await box()).toHaveValue('big cat');
    expect(screen.getByRole('button', { name: 'Remove Kanha' })).toBeInTheDocument();
    expect(await screen.findByText('Photo number 0.')).toBeInTheDocument();
    expect(screen.getByText('Showing 25-48 of 56')).toBeInTheDocument();
  });

  it('has no separate album or People select any more', async () => {
    renderWithProviders(<Search />, { route: '/search?q=lion' });
    await box();
    expect(screen.queryByLabelText('Select photo album')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Anyone')).not.toBeInTheDocument();
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

  it('submitting writes q to the URL, resets to page 1 and leaves AI mode', async () => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('available');
    const { router } = go('/search?q=lion&page=3&mode=ai&kw=diya');

    const input = await box();
    fireEvent.change(input, { target: { value: 'leopard' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(router.state.location.search).toBe('?q=leopard'));
    expect(expandRequest).not.toHaveBeenCalled();
  });

  it('back navigation restores the previous query in the bar', async () => {
    const { router } = go('/search?q=lion');

    const input = await box();
    fireEvent.change(input, { target: { value: 'leopard' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.search).toBe('?q=leopard'));

    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Search' })).toHaveValue('lion'));
  });

  it('paging updates the URL', async () => {
    const { router } = go('/search?q=lion');
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

  describe('chips in the bar', () => {
    it('picking two people from the list puts both ids in the URL and the request', async () => {
      const { router } = go('/search?q=lion&page=2');
      const input = await box();
      await waitFor(() => expect(workerApiClient.getPeople).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.focus(input);
      fireEvent.click(await screen.findByRole('option', { name: 'Asha' }));
      // Unsubmitted typing is local; a pick from the list never writes it.
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion&people=a1'));
      fireEvent.click(await screen.findByRole('option', { name: 'Ravi' }));

      await waitFor(() => expect(router.state.location.search).toBe('?q=lion&people=a1%2Cb2'));
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ people: ['a1', 'b2'] }))
      );
    });

    it('the people filter is restored from the URL as chips and searches without a term', async () => {
      renderWithProviders(<Search />, { route: '/search?people=a1,b2' });
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ people: ['a1', 'b2'] }))
      );
      expect(await screen.findByRole('button', { name: 'Remove Asha' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove Ravi' })).toBeInTheDocument();
    });

    it('removing a person chip removes the param', async () => {
      const { router } = go('/search?q=lion&people=a1');
      fireEvent.click(await screen.findByRole('button', { name: 'Remove Asha' }));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion'));
    });

    it('removing the album chip removes the param', async () => {
      const { router } = go('/search?q=lion&album=Kanha');
      fireEvent.click(await screen.findByRole('button', { name: 'Remove Kanha' }));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion'));
    });

    it('picking a known person writes known and the trimmed text in one update and resets the page', async () => {
      const { router } = go('/search?q=lion&page=2');
      const input = await box();
      await waitFor(() => expect(workerApiClient.getKnownPeople).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: 'lion dho' } });
      fireEvent.click(await screen.findByRole('option', { name: /MS Dhoni/ }));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion&known=ms'));
      expect(screen.getByRole('combobox', { name: 'Search' })).toHaveValue('lion');
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ q: 'lion', known: ['ms'] }))
      );
    });

    it('picking an album suggestion writes album', async () => {
      const { router } = go('/search');
      const input = await box();
      await waitFor(() => expect(workerApiClient.getAlbums).toHaveBeenCalled());
      fireEvent.focus(input);
      fireEvent.click(await screen.findByRole('option', { name: /Kaziranga/ }));
      await waitFor(() => expect(router.state.location.search).toBe('?album=Kaziranga'));
    });

    it('a known-only URL searches without a term and shows the chip', async () => {
      renderWithProviders(<Search />, { route: '/search?known=ms' });
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ known: ['ms'] }))
      );
      expect(await screen.findByRole('button', { name: 'Remove MS Dhoni' })).toBeInTheDocument();
    });

    it('an old people-only URL does not send known', async () => {
      renderWithProviders(<Search />, { route: '/search?people=a1' });
      await waitFor(() => expect(workerApiClient.searchPage).toHaveBeenCalled());
      expect(vi.mocked(workerApiClient.searchPage).mock.calls[0][0]).not.toHaveProperty('known');
    });
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
      expect(screen.getByRole('button', { name: 'Remove 2025-06-01 to 2025-06-30' })).toBeInTheDocument();
    });

    it('removing the date chip clears from, to and onThisDay', async () => {
      const { router } = go('/search?q=lion&from=2025-06-01&to=2025-06-30');
      fireEvent.click(await screen.findByRole('button', { name: 'Remove 2025-06-01 to 2025-06-30' }));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion'));
    });

    it('the This month chip sets from and to in the URL', async () => {
      freezeDate();
      const { router } = go('/search?q=lion&page=2');
      fireEvent.click(await screen.findByLabelText('This month'));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion&from=2025-06-01&to=2025-06-30'));
    });

    it('On this day sets onThisDay and clears the range, and a range clears it back', async () => {
      freezeDate();
      const { router } = go('/search?from=2025-06-01&to=2025-06-30');
      fireEvent.click(await screen.findByLabelText('On this day'));
      await waitFor(() => expect(router.state.location.search).toBe('?onThisDay=06-15'));
      await waitFor(() =>
        expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ onThisDay: '06-15' }))
      );

      fireEvent.click(screen.getByLabelText('This year'));
      await waitFor(() => expect(router.state.location.search).toBe('?from=2025-01-01&to=2025-12-31'));
    });

    it('clicking an active chip turns it off', async () => {
      const { router } = go('/search?onThisDay=06-15');
      fireEvent.click(await screen.findByLabelText('On this day'));
      await waitFor(() => expect(router.state.location.search).toBe(''));
    });

    it('submitting a typed date writes q, from and to together', async () => {
      const { router } = go('/search?page=3');
      const input = await box();
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
      const { router } = go('/search?q=lion');
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
      const { router } = go('/search?q=lion&from=2025-06-01&to=2025-06-30');
      fireEvent.click(await screen.findByLabelText('Clear dates'));
      await waitFor(() => expect(router.state.location.search).toBe('?q=lion'));
    });
  });
});

describe('Search without the Prompt API', () => {
  it('has no Ask AI control', async () => {
    renderWithProviders(<Search />, { route: '/search?q=lion' });
    await waitFor(() => expect(getPromptApiStatus).toHaveBeenCalled());
    await waitFor(() => expect(workerApiClient.searchPage).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Ask AI/ })).not.toBeInTheDocument();
  });

  it('strips the AI params from /search?mode=ai and runs a plain search', async () => {
    const { router } = go('/search?mode=ai&q=lion&kw=a,b&hidePeople=0&room=0&album=Kanha');
    await waitFor(() => expect(router.state.location.search).toBe('?q=lion&album=Kanha'));
    expect(router.state.location.pathname).toBe('/search');
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ q: 'lion', album: 'Kanha' }))
    );
    expect(runAiSearch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Ask AI/ })).not.toBeInTheDocument();
  });

  it('/ai-search lands on /search without AI params', async () => {
    const { router } = go('/ai-search?q=x&kw=a,b&people=0&room=0');
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    await waitFor(() => expect(router.state.location.search).toBe('?q=x'));
    expect(runAiSearch).not.toHaveBeenCalled();
  });

  it('/ai-search shows a loader while checking', async () => {
    vi.mocked(getPromptApiStatus).mockReturnValue(new Promise(() => {}));
    const { router } = go('/ai-search?q=x');
    await waitFor(() => expect(document.querySelector('.mantine-Loader-root')).not.toBeNull());
    expect(router.state.location.pathname).toBe('/ai-search');
  });
});

describe('Search (AI mode)', () => {
  beforeEach(() => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('available');
  });

  const askAi = async (text: string) => {
    const input = await box();
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(await screen.findByRole('button', { name: /Ask AI/ }));
  };

  it('/ai-search with old params lands on /search in AI mode', async () => {
    const { router } = go('/ai-search?q=x&kw=a,b&people=0&room=0');
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toBe('?mode=ai&q=x&kw=a%2Cb&hidePeople=0&room=0');
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['a', 'b'], { hidePeople: false, leaveRoom: false }, undefined, {
        album: '',
        people: [],
        known: [],
        from: '',
        to: '',
        onThisDay: '',
      })
    );
  });

  it('searches from kw in the URL without calling the model, and shows the keyword chips', async () => {
    go('/search?mode=ai&kw=diya,golden');
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['diya', 'golden'], both, undefined, expect.anything())
    );
    expect(expandRequest).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Edit keyword diya' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit keyword golden' })).toBeInTheDocument();
    expect(workerApiClient.searchPage).not.toHaveBeenCalled();
  });

  it('reads hidePeople=0 and room=0 as both options off', async () => {
    go('/search?mode=ai&kw=diya&hidePeople=0&room=0');
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(
        ['diya'],
        { hidePeople: false, leaveRoom: false },
        undefined,
        expect.anything()
      )
    );
    expect(await screen.findByRole('switch', { name: 'Hide people photos' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Leave room for text' })).not.toBeChecked();
  });

  it('does not search without keywords', async () => {
    go('/search?mode=ai');
    expect(await screen.findByText(/Describe what the photos are for/)).toBeInTheDocument();
    expect(runAiSearch).not.toHaveBeenCalled();
  });

  it('passes the active album, people, known and date filters to the pipeline', async () => {
    go('/search?mode=ai&kw=diya&album=Kanha&known=ms&from=2025-01-01&to=2025-12-31');
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['diya'], { hidePeople: false, leaveRoom: true }, undefined, {
        album: 'Kanha',
        people: [],
        known: ['ms'],
        from: '2025-01-01',
        to: '2025-12-31',
        onThisDay: '',
      })
    );
  });

  it('with a person chip the hide switch is not rendered and hidePeople false is passed, keeping the URL value', async () => {
    const { router } = go('/search?mode=ai&kw=diya&people=a1');
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(
        ['diya'],
        { hidePeople: false, leaveRoom: true },
        undefined,
        expect.objectContaining({ people: ['a1'] })
      )
    );
    expect(await screen.findByRole('switch', { name: 'Leave room for text' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Hide people photos' })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Asha' }));
    await waitFor(() => expect(urlParams(router).has('people')).toBe(false));
    expect(urlParams(router).get('mode')).toBe('ai');
    await waitFor(() => expect(runAiSearch).toHaveBeenLastCalledWith(['diya'], both, undefined, expect.anything()));
    expect(screen.getByRole('switch', { name: 'Hide people photos' })).toBeChecked();
  });

  it('Ask AI expands the typed request, then sets mode, q and kw in the URL and searches', async () => {
    vi.mocked(expandRequest).mockImplementation(async (_request, onStatus) => {
      onStatus?.('Downloading the on-device model: 40%');
      return { occasion: 'diwali', keywords: ['diwali', 'diya', 'golden'] };
    });
    const { router } = go('/search?page=2');

    await askAi('Diwali wishes for colleagues');

    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['diwali', 'diya', 'golden'], both, undefined, expect.anything())
    );
    expect(expandRequest).toHaveBeenCalledWith('Diwali wishes for colleagues', expect.any(Function));
    expect(router.state.location.search).toBe('?mode=ai&q=Diwali+wishes+for+colleagues&kw=diwali%2Cdiya%2Cgolden');
    expect(await screen.findByRole('button', { name: 'Edit keyword golden' })).toBeInTheDocument();
  });

  it('Ask AI never parses a typed date', async () => {
    vi.mocked(expandRequest).mockResolvedValue({ occasion: 'x', keywords: ['beach'] });
    const { router } = go('/search');
    await askAi('june 2025 beach');
    await waitFor(() => expect(urlParams(router).get('kw')).toBe('beach'));
    expect(expandRequest).toHaveBeenCalledWith('june 2025 beach', expect.any(Function));
    expect(urlParams(router).get('q')).toBe('june 2025 beach');
    expect(urlParams(router).has('from')).toBe(false);
  });

  it('Cmd+Enter runs Ask AI', async () => {
    vi.mocked(expandRequest).mockResolvedValue({ occasion: 'x', keywords: ['xmas'] });
    const { router } = go('/search');
    await screen.findByRole('button', { name: /Ask AI/ });
    const input = await box();
    fireEvent.change(input, { target: { value: 'Xmas' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(urlParams(router).get('kw')).toBe('xmas'));
    expect(urlParams(router).get('mode')).toBe('ai');
  });

  it('shows the model status while the expansion runs', async () => {
    let finish: (v: { occasion: string; keywords: string[] }) => void = () => {};
    vi.mocked(expandRequest).mockImplementation((_request, onStatus) => {
      onStatus?.('Downloading the on-device model: 40%');
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    go('/search');

    await askAi('Xmas');

    expect(await screen.findByText(/Downloading the on-device model: 40%/)).toBeInTheDocument();
    expect(screen.getByText(/Running on this device/)).toBeInTheDocument();
    expect(screen.getByText(/0s/)).toBeInTheDocument();

    await act(async () => finish({ occasion: 'xmas', keywords: ['xmas'] }));
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['xmas'], both, undefined, expect.anything()));
    await waitFor(() => expect(screen.queryByText(/Running on this device/)).not.toBeInTheDocument());
  });

  it('flipping a switch while the expansion runs is not undone when it completes', async () => {
    let finish: (v: { occasion: string; keywords: string[] }) => void = () => {};
    vi.mocked(expandRequest).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { router } = go('/search?mode=ai&kw=diya');
    await askAi('Xmas');
    await waitFor(() => expect(expandRequest).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('switch', { name: 'Leave room for text' }));
    await waitFor(() => expect(urlParams(router).get('room')).toBe('0'));

    await act(async () => finish({ occasion: 'xmas', keywords: ['xmas'] }));
    await waitFor(() => expect(urlParams(router).get('kw')).toBe('xmas'));
    expect(urlParams(router).get('room')).toBe('0');
    expect(urlParams(router).get('mode')).toBe('ai');
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenLastCalledWith(
        ['xmas'],
        { hidePeople: true, leaveRoom: false },
        undefined,
        expect.anything()
      )
    );
  });

  it('Ask AI twice while the model runs calls it once', async () => {
    vi.mocked(expandRequest).mockImplementation(() => new Promise(() => {}));
    go('/search');
    await screen.findByRole('button', { name: /Ask AI/ });
    const input = await box();
    fireEvent.change(input, { target: { value: 'Xmas' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(expandRequest).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(expandRequest).toHaveBeenCalledTimes(1);
  });

  it('searching the keywords again while the model runs keeps Ask AI busy', async () => {
    vi.mocked(expandRequest).mockImplementation(() => new Promise(() => {}));
    go('/search?mode=ai&kw=diya');
    await askAi('Xmas');
    await waitFor(() => expect(expandRequest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Ask AI/ })).toHaveAttribute('data-loading'));

    fireEvent.keyDown(screen.getByLabelText('Add keywords'), { key: 'Enter' });

    expect(screen.getByRole('button', { name: /Ask AI/ })).toHaveAttribute('data-loading');
  });

  it('switching Hide people photos off writes hidePeople=0 and re-runs', async () => {
    const { router } = go('/search?mode=ai&kw=diya');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['diya'], both, undefined, expect.anything()));

    fireEvent.click(await screen.findByRole('switch', { name: 'Hide people photos' }));

    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(
        ['diya'],
        { hidePeople: false, leaveRoom: true },
        undefined,
        expect.anything()
      )
    );
    expect(urlParams(router).get('hidePeople')).toBe('0');
    expect(urlParams(router).has('people')).toBe(false);
  });

  it('switching Leave room for text off writes room=0, and back on removes it', async () => {
    const { router } = go('/search?mode=ai&kw=diya');
    fireEvent.click(await screen.findByRole('switch', { name: 'Leave room for text' }));
    await waitFor(() => expect(urlParams(router).get('room')).toBe('0'));
    fireEvent.click(screen.getByRole('switch', { name: 'Leave room for text' }));
    await waitFor(() => expect(urlParams(router).has('room')).toBe(false));
    await waitFor(() => expect(runAiSearch).toHaveBeenLastCalledWith(['diya'], both, undefined, expect.anything()));
  });

  it('adding a keyword then Enter searches again with it, without calling the model', async () => {
    const { router } = go('/search?mode=ai&kw=diya');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledTimes(1));

    const add = await screen.findByLabelText('Add keywords');
    fireEvent.change(add, { target: { value: 'Rangoli, lamp , diya' } });
    fireEvent.keyDown(add, { key: 'Enter' });

    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['diya', 'rangoli', 'lamp'], both, undefined, expect.anything())
    );
    expect(expandRequest).not.toHaveBeenCalled();
    expect(urlParams(router).get('kw')).toBe('diya,rangoli,lamp');
    expect(router.state.location.search).toBe('?mode=ai&kw=diya%2Crangoli%2Clamp');
  });

  it('editing a keyword chip then Enter re-searches with the edit', async () => {
    const { router } = go('/search?mode=ai&kw=diya,golden');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit keyword golden' }));
    const add = screen.getByLabelText('Add keywords');
    fireEvent.change(add, { target: { value: 'silver' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    await waitFor(() => expect(urlParams(router).get('kw')).toBe('diya,silver'));
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['diya', 'silver'], both, undefined, expect.anything())
    );
    expect(expandRequest).not.toHaveBeenCalled();
  });

  it('Enter in an empty keyword box searches the same keywords again', async () => {
    go('/search?mode=ai&kw=diya');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(await screen.findByLabelText('Add keywords'), { key: 'Enter' });
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledTimes(2));
    expect(expandRequest).not.toHaveBeenCalled();
  });

  it('removing a keyword chip writes kw and re-runs', async () => {
    const { router } = go('/search?mode=ai&kw=diya,golden');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove keyword golden' }));
    await waitFor(() => expect(urlParams(router).get('kw')).toBe('diya'));
    await waitFor(() => expect(runAiSearch).toHaveBeenLastCalledWith(['diya'], both, undefined, expect.anything()));
  });

  it('shows a model error and lets you type keywords and search anyway', async () => {
    vi.mocked(expandRequest).mockRejectedValue(new Error('The model did not return keywords'));
    const { router } = go('/search');

    await askAi('Xmas');

    expect(await screen.findByText('The model did not return keywords')).toBeInTheDocument();
    expect(runAiSearch).not.toHaveBeenCalled();
    expect(urlParams(router).has('mode')).toBe(false);

    const add = await screen.findByLabelText('Add keywords');
    fireEvent.change(add, { target: { value: 'star, snow' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['star', 'snow'], both, undefined, expect.anything()));
    expect(urlParams(router).get('mode')).toBe('ai');
  });

  it('a model error keeps the keywords already in the URL', async () => {
    vi.mocked(expandRequest).mockRejectedValue(new Error('Model failed'));
    const { router } = go('/search?mode=ai&kw=diya');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledTimes(1));

    await askAi('Xmas');

    expect(await screen.findByText('Model failed')).toBeInTheDocument();
    expect(urlParams(router).get('kw')).toBe('diya');
    expect(screen.getByRole('button', { name: 'Edit keyword diya' })).toBeInTheDocument();
  });

  it('shows an empty state suggesting editing keywords when nothing matches', async () => {
    go('/search?mode=ai&kw=diya');
    expect(await screen.findByText(/No photos found\. Try editing the keywords/)).toBeInTheDocument();
  });

  it('lists keywords with zero matches and failed keywords', async () => {
    vi.mocked(runAiSearch).mockResolvedValue({
      items: [],
      keywords: [
        { term: 'diya', total: 12, failed: false },
        { term: 'rangoli', total: 0, failed: false },
        { term: 'lamp', total: 0, failed: true },
      ],
      hiddenPeople: 0,
    });
    go('/search?mode=ai&kw=diya,rangoli,lamp');
    expect(await screen.findByText('rangoli: no matches')).toBeInTheDocument();
    expect(screen.getByText('lamp: failed')).toBeInTheDocument();
    expect(screen.queryByText('diya: no matches')).not.toBeInTheDocument();
  });

  it('shows a search error message', async () => {
    vi.mocked(runAiSearch).mockRejectedValue(new Error('Every keyword search failed'));
    go('/search?mode=ai&kw=diya');
    expect(await screen.findByText('Every keyword search failed')).toBeInTheDocument();
  });

  it('shows matched keywords, text space and rating on each card, and no pagination', async () => {
    vi.mocked(runAiSearch).mockResolvedValue({
      items: [
        {
          photo: makePhoto({ id: 'p1', description: 'Lamps at dusk.' }),
          hits: ['diya', 'golden'],
          textSpace: { side: 'top', score: 0.724 },
          rating: 8.4,
          finalScore: 1.5,
        },
        {
          photo: makePhoto({ id: 'p2', description: 'A marigold.' }),
          hits: ['golden'],
          textSpace: null,
          rating: 7,
          finalScore: 1,
        },
      ],
      keywords: [
        { term: 'diya', total: 12, failed: false },
        { term: 'golden', total: 300, failed: false },
      ],
      hiddenPeople: 3,
    });
    go('/search?mode=ai&kw=diya,golden');

    expect(await screen.findByText('matched: diya, golden')).toBeInTheDocument();
    expect(screen.getByText('Text space: 72% (top)')).toBeInTheDocument();
    expect(screen.getByText('Rating: 8.4')).toBeInTheDocument();
    expect(screen.getByText('matched: golden')).toBeInTheDocument();
    expect(screen.getAllByText(/Text space:/)).toHaveLength(1);
    expect(screen.getByText(/3 people photos hidden/)).toBeInTheDocument();
    expect(screen.getByText('Lamps at dusk.').closest('a')).toHaveAttribute('href', '/photos/p1');
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
  });

  it('shows at most 48 cards', async () => {
    const items: RankedPhoto[] = Array.from({ length: 50 }, (_, i) => ({
      photo: makePhoto({ id: `r${i}`, description: `Ranked ${i}.` }),
      hits: ['diya'],
      textSpace: null,
      rating: 5,
      finalScore: 1,
    }));
    vi.mocked(runAiSearch).mockResolvedValue({ items, keywords: [], hiddenPeople: 0 });
    go('/search?mode=ai&kw=diya');
    expect(await screen.findByText('Ranked 0.')).toBeInTheDocument();
    expect(screen.getAllByText('matched: diya')).toHaveLength(48);
    expect(screen.queryByText('Ranked 48.')).not.toBeInTheDocument();
  });
});
