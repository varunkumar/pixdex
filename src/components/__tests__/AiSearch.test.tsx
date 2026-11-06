import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAiSearch, type AiSearchResult } from '../../services/aiSearch/pipeline';
import { expandRequest, getPromptApiStatus } from '../../services/aiSearch/promptApi';
import { makePhoto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/renderWithProviders';
import AiSearch from '../AiSearch';

vi.mock('../../services/aiSearch/promptApi', () => ({ getPromptApiStatus: vi.fn(), expandRequest: vi.fn() }));
vi.mock('../../services/aiSearch/pipeline', () => ({ runAiSearch: vi.fn() }));
vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));
vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

const routes = [
  { path: '/', element: <div>home</div> },
  { path: '/ai-search', element: <AiSearch /> },
];

const emptyResult: AiSearchResult = { items: [], keywords: [], hiddenPeople: 0 };

describe('AiSearch route guard', () => {
  beforeEach(() => {
    vi.mocked(getPromptApiStatus).mockReset();
    vi.mocked(runAiSearch).mockReset().mockResolvedValue(emptyResult);
  });

  it('redirects home when unsupported', async () => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('unsupported');
    const { router } = renderWithRouter(routes, ['/ai-search']);
    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('shows the heading when supported', async () => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('available');
    const { router } = renderWithRouter(routes, ['/ai-search']);
    expect(await screen.findByRole('heading', { name: 'AI Search' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/ai-search');
  });

  it('shows a loader while checking', async () => {
    vi.mocked(getPromptApiStatus).mockReturnValue(new Promise(() => {}));
    const { router } = renderWithRouter(routes, ['/ai-search']);
    await waitFor(() => expect(document.querySelector('.mantine-Loader-root')).not.toBeNull());
    expect(router.state.location.pathname).toBe('/ai-search');
  });
});

describe('AiSearch page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPromptApiStatus).mockResolvedValue('available');
    vi.mocked(runAiSearch).mockResolvedValue(emptyResult);
  });

  const render = (url: string) => renderWithRouter(routes, [url]);
  const keywordBox = () => screen.findByLabelText('Keywords');

  it('searches from kw in the URL without calling the model', async () => {
    render('/ai-search?kw=diya,golden');
    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['diya', 'golden'], { hidePeople: true, leaveRoom: true })
    );
    expect(expandRequest).not.toHaveBeenCalled();
    expect(await keywordBox()).toHaveValue('diya, golden');
  });

  it('reads people=0 and room=0 as both options off', async () => {
    render('/ai-search?kw=diya&people=0&room=0');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['diya'], { hidePeople: false, leaveRoom: false }));
    expect(await screen.findByRole('switch', { name: 'Hide people photos' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Leave room for text' })).not.toBeChecked();
  });

  it('does not search without keywords', async () => {
    render('/ai-search');
    expect(await keywordBox()).toHaveValue('');
    expect(runAiSearch).not.toHaveBeenCalled();
  });

  it('expands the typed request and searches with the returned keywords', async () => {
    vi.mocked(expandRequest).mockImplementation(async (_request, onStatus) => {
      onStatus?.('Downloading the on-device model: 40%');
      return { occasion: 'diwali', keywords: ['diwali', 'diya', 'golden'] };
    });
    const { router } = render('/ai-search');

    fireEvent.change(await screen.findByLabelText('What do you need photos for?'), {
      target: { value: 'Diwali wishes for colleagues' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find photos' }));

    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['diwali', 'diya', 'golden'], { hidePeople: true, leaveRoom: true })
    );
    expect(expandRequest).toHaveBeenCalledWith('Diwali wishes for colleagues', expect.any(Function));
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('kw')).toBe('diwali,diya,golden');
    expect(params.get('q')).toBe('Diwali wishes for colleagues');
    expect(params.has('people')).toBe(false);
    expect(params.has('room')).toBe(false);
    expect(await keywordBox()).toHaveValue('diwali, diya, golden');
  });

  it('shows the model status while the expansion runs', async () => {
    let finish: (v: { occasion: string; keywords: string[] }) => void = () => {};
    vi.mocked(expandRequest).mockImplementation((_request, onStatus) => {
      onStatus?.('Downloading the on-device model: 40%');
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    render('/ai-search');

    fireEvent.change(await screen.findByLabelText('What do you need photos for?'), { target: { value: 'Xmas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find photos' }));

    expect(await screen.findByText(/Downloading the on-device model: 40%/)).toBeInTheDocument();
    expect(screen.getByText(/Running on this device/)).toBeInTheDocument();
    expect(screen.getByText(/0s/)).toBeInTheDocument();

    finish({ occasion: 'xmas', keywords: ['xmas'] });
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['xmas'], expect.anything()));
    await waitFor(() => expect(screen.queryByText(/Running on this device/)).not.toBeInTheDocument());
  });

  it('re-runs with hidePeople false when Hide people photos is switched off', async () => {
    const { router } = render('/ai-search?kw=diya');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['diya'], { hidePeople: true, leaveRoom: true }));

    fireEvent.click(await screen.findByRole('switch', { name: 'Hide people photos' }));

    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['diya'], { hidePeople: false, leaveRoom: true }));
    expect(new URLSearchParams(router.state.location.search).get('people')).toBe('0');
  });

  it('turning an option back on removes it from the URL', async () => {
    const { router } = render('/ai-search?kw=diya&room=0');
    fireEvent.click(await screen.findByRole('switch', { name: 'Leave room for text' }));
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['diya'], { hidePeople: true, leaveRoom: true }));
    expect(new URLSearchParams(router.state.location.search).has('room')).toBe(false);
  });

  it('Search again uses the edited keywords without calling the model', async () => {
    const { router } = render('/ai-search?kw=diya');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledTimes(1));

    fireEvent.change(await keywordBox(), { target: { value: 'Rangoli, lamp , rangoli' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));

    await waitFor(() =>
      expect(runAiSearch).toHaveBeenCalledWith(['rangoli', 'lamp'], { hidePeople: true, leaveRoom: true })
    );
    expect(expandRequest).not.toHaveBeenCalled();
    expect(new URLSearchParams(router.state.location.search).get('kw')).toBe('rangoli,lamp');
  });

  it('shows a model error and leaves the keyword box empty and editable', async () => {
    vi.mocked(expandRequest).mockRejectedValue(new Error('The model did not return keywords'));
    render('/ai-search');

    fireEvent.change(await screen.findByLabelText('What do you need photos for?'), { target: { value: 'Xmas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find photos' }));

    expect(await screen.findByText('The model did not return keywords')).toBeInTheDocument();
    const box = await keywordBox();
    expect(box).toHaveValue('');
    expect(box).toBeEnabled();
    expect(runAiSearch).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: 'star, snow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledWith(['star', 'snow'], expect.anything()));
  });

  it('a model error keeps the keywords already in the URL', async () => {
    vi.mocked(expandRequest).mockRejectedValue(new Error('Model failed'));
    const { router } = render('/ai-search?kw=diya');
    await waitFor(() => expect(runAiSearch).toHaveBeenCalledTimes(1));

    fireEvent.change(await screen.findByLabelText('What do you need photos for?'), { target: { value: 'Xmas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find photos' }));

    expect(await screen.findByText('Model failed')).toBeInTheDocument();
    expect(new URLSearchParams(router.state.location.search).get('kw')).toBe('diya');
    expect(await keywordBox()).toHaveValue('diya');
  });

  it('shows an empty state suggesting editing keywords when nothing matches', async () => {
    render('/ai-search?kw=diya');
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
    render('/ai-search?kw=diya,rangoli,lamp');
    expect(await screen.findByText('rangoli: no matches')).toBeInTheDocument();
    expect(screen.getByText('lamp: failed')).toBeInTheDocument();
    expect(screen.queryByText('diya: no matches')).not.toBeInTheDocument();
  });

  it('shows a search error message', async () => {
    vi.mocked(runAiSearch).mockRejectedValue(new Error('Every keyword search failed'));
    render('/ai-search?kw=diya');
    expect(await screen.findByText('Every keyword search failed')).toBeInTheDocument();
  });

  it('shows matched keywords, text space and rating on each card', async () => {
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
    render('/ai-search?kw=diya,golden');

    expect(await screen.findByText('matched: diya, golden')).toBeInTheDocument();
    expect(screen.getByText('Text space: 72% (top)')).toBeInTheDocument();
    expect(screen.getByText('Rating: 8.4')).toBeInTheDocument();
    expect(screen.getByText('matched: golden')).toBeInTheDocument();
    expect(screen.getAllByText(/Text space:/)).toHaveLength(1);
    expect(screen.getByText(/3 people photos hidden/)).toBeInTheDocument();
    expect(screen.getByText('Lamps at dusk.').closest('a')).toHaveAttribute('href', '/photos/p1');
  });
});
