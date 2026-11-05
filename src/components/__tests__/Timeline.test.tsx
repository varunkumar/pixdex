import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import type { TimelineResponse } from '../../types/api';
import { makePhoto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/renderWithProviders';
import Timeline from '../Timeline';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getTimeline: vi.fn(),
    getAlbums: vi.fn(),
    getPeople: vi.fn(),
    getTimelineBuckets: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));

vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

let intersect: (isIntersecting: boolean) => void = () => {};

class FakeIntersectionObserver {
  constructor(cb: IntersectionObserverCallback) {
    intersect = (isIntersecting) =>
      cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    intersect = () => {};
  }
}

const photos = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => makePhoto({ id: `${prefix}${i}`, description: `Photo ${prefix}${i}.` }));

const monthPage: TimelineResponse = {
  groups: [
    { key: '2026-11', total: 142, shown: 18, photos: photos('n', 2) },
    { key: '2026-10', total: 7, shown: 0, photos: [] },
  ],
  nextCursor: 'c1',
};

const renderAt = (url: string) => renderWithRouter([{ path: '/timeline', element: <Timeline /> }], [url]);

const search = (router: { state: { location: { search: string } } }) =>
  new URLSearchParams(router.state.location.search);

describe('Timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha', 'Kaziranga']);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'a1', name: 'Asha', faceCount: 3, photoCount: 3, cover: null },
    ]);
    vi.mocked(workerApiClient.getTimeline).mockResolvedValue(monthPage);
    vi.mocked(workerApiClient.getTimelineBuckets).mockResolvedValue({
      buckets: [
        { month: '2026-11', total: 142 },
        { month: '2026-10', total: 7 },
        { month: '2025-03', total: 5 },
      ],
      undated: 0,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows month headings with total and shown counts', async () => {
    renderAt('/timeline');
    expect(await screen.findByText('November 2026')).toBeInTheDocument();
    expect(screen.getByText('142 photos, 18 shown')).toBeInTheDocument();
    expect(screen.getByText('Photo n0.')).toBeInTheDocument();
    expect(workerApiClient.getTimeline).toHaveBeenCalledWith(expect.objectContaining({ zoom: 'month' }));
  });

  it('says to zoom in for a month with nothing shown', async () => {
    renderAt('/timeline');
    expect(await screen.findByText('October 2026')).toBeInTheDocument();
    expect(screen.getByText('7 photos, zoom in to see')).toBeInTheDocument();
  });

  it('shows day headings and the Undated group at day zoom', async () => {
    vi.mocked(workerApiClient.getTimeline).mockResolvedValue({
      groups: [
        { key: '2026-11-05', total: 3, shown: 3, photos: photos('d', 1) },
        { key: 'undated', total: 4, shown: 4, photos: photos('u', 1) },
      ],
      nextCursor: null,
    });
    renderAt('/timeline?zoom=day');
    expect(await screen.findByText('Thu 5 Nov 2026')).toBeInTheDocument();
    expect(screen.getByText('Undated')).toBeInTheDocument();
    expect(workerApiClient.getTimeline).toHaveBeenCalledWith(expect.objectContaining({ zoom: 'day' }));
  });

  it('changes zoom in the URL from the segmented control and refetches', async () => {
    const { router } = renderAt('/timeline');
    await screen.findByText('November 2026');
    fireEvent.click(screen.getByText('Day'));
    await waitFor(() => expect(search(router).get('zoom')).toBe('day'));
    await waitFor(() =>
      expect(workerApiClient.getTimeline).toHaveBeenCalledWith(expect.objectContaining({ zoom: 'day' }))
    );
    fireEvent.click(screen.getByText('Month'));
    await waitFor(() => expect(search(router).has('zoom')).toBe(false));
  });

  it('steps zoom with ctrl+wheel: up toward Day, down toward Year', async () => {
    const { router } = renderAt('/timeline');
    const grid = await screen.findByTestId('timeline-grid');
    fireEvent.wheel(grid, { ctrlKey: true, deltaY: -100 });
    await waitFor(() => expect(search(router).get('zoom')).toBe('day'));

    fireEvent.wheel(grid, { ctrlKey: true, deltaY: 100 });
    await waitFor(() => expect(search(router).has('zoom')).toBe(false));
    fireEvent.wheel(grid, { ctrlKey: true, deltaY: 100 });
    await waitFor(() => expect(search(router).get('zoom')).toBe('year'));
  });

  it('ignores wheel without ctrl', async () => {
    const { router } = renderAt('/timeline');
    const grid = await screen.findByTestId('timeline-grid');
    fireEvent.wheel(grid, { deltaY: -100 });
    await new Promise((r) => setTimeout(r, 350));
    expect(search(router).has('zoom')).toBe(false);
  });

  it('fetches the next cursor when the sentinel comes into view', async () => {
    vi.mocked(workerApiClient.getTimeline)
      .mockResolvedValueOnce(monthPage)
      .mockResolvedValueOnce({
        groups: [{ key: '2026-09', total: 1, shown: 1, photos: photos('s', 1) }],
        nextCursor: null,
      });
    renderAt('/timeline');
    await screen.findByText('November 2026');
    act(() => intersect(true));
    expect(await screen.findByText('September 2026')).toBeInTheDocument();
    expect(workerApiClient.getTimeline).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1' }));
  });

  it('shows an empty state when nothing matches', async () => {
    vi.mocked(workerApiClient.getTimeline).mockResolvedValue({ groups: [], nextCursor: null });
    renderAt('/timeline?album=Kanha');
    expect(await screen.findByText('No photos match these filters.')).toBeInTheDocument();
  });

  it('requests with album, people and to from the URL', async () => {
    renderAt('/timeline?album=Kanha&people=a1&to=2025-02-28');
    await waitFor(() =>
      expect(workerApiClient.getTimeline).toHaveBeenCalledWith(
        expect.objectContaining({ zoom: 'month', album: 'Kanha', people: ['a1'], to: '2025-02-28' })
      )
    );
  });

  it('writes the album filter to the URL', async () => {
    const { router } = renderAt('/timeline');
    await screen.findByText('November 2026');
    fireEvent.click(screen.getByLabelText('Select photo album'));
    fireEvent.click(await screen.findByText('Kaziranga'));
    await waitFor(() => expect(search(router).get('album')).toBe('Kaziranga'));
  });

  it('keeps loaded groups, stops auto-fetching and offers retry when a next page fails', async () => {
    vi.mocked(workerApiClient.getTimeline)
      .mockResolvedValueOnce(monthPage)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        groups: [{ key: '2026-09', total: 1, shown: 1, photos: photos('s', 1) }],
        nextCursor: null,
      });
    renderAt('/timeline');
    await screen.findByText('November 2026');
    act(() => intersect(true));
    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(screen.getByText('November 2026')).toBeInTheDocument();
    expect(screen.queryByText('Could not load the timeline.')).not.toBeInTheDocument();
    act(() => intersect(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(workerApiClient.getTimeline).toHaveBeenCalledTimes(2);
    fireEvent.click(retry);
    expect(await screen.findByText('September 2026')).toBeInTheDocument();
    expect(workerApiClient.getTimeline).toHaveBeenCalledTimes(3);
  });

  it('shows the full-page error when the first page fails', async () => {
    vi.mocked(workerApiClient.getTimeline).mockRejectedValue(new Error('boom'));
    renderAt('/timeline');
    expect(await screen.findByText('Could not load the timeline.')).toBeInTheDocument();
  });

  it('ignores ctrl+wheel with no vertical movement', async () => {
    const { router } = renderAt('/timeline');
    const grid = await screen.findByTestId('timeline-grid');
    fireEvent.wheel(grid, { ctrlKey: true, deltaY: 0 });
    await new Promise((r) => setTimeout(r, 350));
    expect(search(router).has('zoom')).toBe(false);
  });

  it('uses a neutral empty message when no filters are set', async () => {
    vi.mocked(workerApiClient.getTimeline).mockResolvedValue({ groups: [], nextCursor: null });
    renderAt('/timeline');
    expect(await screen.findByText('No photos to show.')).toBeInTheDocument();
  });

  it('jumps from the scrubber: sets to, reloads the feed and scrolls to the top', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    const { router } = renderAt('/timeline');
    await screen.findByText('November 2026');
    fireEvent.click(await screen.findByRole('button', { name: 'March 2025' }));
    await waitFor(() => expect(search(router).get('to')).toBe('2025-03-31'));
    await waitFor(() =>
      expect(workerApiClient.getTimeline).toHaveBeenLastCalledWith(expect.objectContaining({ to: '2025-03-31' }))
    );
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('fetches scrubber buckets by album and people only', async () => {
    renderAt('/timeline?album=Kanha&people=a1&to=2026-10-31&zoom=day');
    await screen.findByRole('button', { name: 'March 2025' });
    expect(workerApiClient.getTimelineBuckets).toHaveBeenCalledTimes(1);
    expect(workerApiClient.getTimelineBuckets).toHaveBeenCalledWith({ album: 'Kanha', people: ['a1'] });
  });

  it('marks the month of the heading nearest the top as active', async () => {
    renderAt('/timeline');
    await screen.findByText('November 2026');
    await screen.findByRole('button', { name: 'November 2026' });
    const october = screen.getByText('October 2026').closest('[data-group-key]') as HTMLElement;
    const november = screen.getByText('November 2026', { selector: 'h4' }).closest('[data-group-key]') as HTMLElement;
    const place = (nov: number, oct: number) => {
      november.getBoundingClientRect = () => ({ top: nov }) as DOMRect;
      october.getBoundingClientRect = () => ({ top: oct }) as DOMRect;
      fireEvent.scroll(window);
    };
    place(20, 600);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'November 2026' })).toHaveAttribute('aria-current', 'true')
    );
    place(-500, 20);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'October 2026' })).toHaveAttribute('aria-current', 'true')
    );
  });

  it('shows the jump position and clears it with Back to latest', async () => {
    const { router } = renderAt('/timeline?to=2025-03-31');
    expect(await screen.findByText('Showing photos up to Mar 2025')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }));
    await waitFor(() => expect(search(router).has('to')).toBe(false));
    expect(screen.queryByText('Showing photos up to Mar 2025')).not.toBeInTheDocument();
  });

  it('shows no jump chip when to is unset', async () => {
    renderAt('/timeline');
    await screen.findByText('November 2026');
    expect(screen.queryByRole('button', { name: 'Back to latest' })).not.toBeInTheDocument();
  });
});
