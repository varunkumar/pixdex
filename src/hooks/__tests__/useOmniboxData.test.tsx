import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { useOmniboxData, type OmniboxSelection } from '../useOmniboxData';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPeople: vi.fn(),
    getKnownPeople: vi.fn(),
    getAlbums: vi.fn(),
    searchPage: vi.fn(),
  },
}));

// One client per test, created once (not per render), so cache behaviour is real.
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <MantineProvider>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </MantineProvider>
);

const none: OmniboxSelection = { album: '', people: [], known: [], from: '', to: '', onThisDay: '' };
const person = (id: string, name: string | null, photoCount = 5) => ({
  id, name, faceCount: 1, photoCount, canEdit: true, cover: null,
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.resetAllMocks();
  vi.mocked(workerApiClient.getPeople).mockResolvedValue([person('p1', 'Anita Rao'), person('p2', 'Bob Stone')]);
  vi.mocked(workerApiClient.getKnownPeople).mockResolvedValue([
    { id: 'Q1', name: 'Anita Rao', aliases: [], photoCount: 3 },
    { id: 'Q2', name: 'Carl Moon', aliases: ['Charlie'], photoCount: 2 },
  ]);
  vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Goa Trip']);
  vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 7 });
});

const loaded = async (result: { current: ReturnType<typeof useOmniboxData> }) =>
  waitFor(() => expect(result.current.listsLoaded).toEqual({ people: true, known: true, albums: true }));

describe('useOmniboxData', () => {
  it('loads each list once across text changes and searches only after the debounce, once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderHook(({ t }) => useOmniboxData(t, none), { wrapper, initialProps: { t: '' } });
      await loaded(result);
      for (const t of ['bob', 'bob stone', 'bob stone carl', 'bob stone carl moon']) rerender({ t });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(result.current.spans).toEqual([]);
      expect(workerApiClient.searchPage).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      await waitFor(() => expect(result.current.bothCount?.total).toBe(7));
      expect(result.current.spans).toHaveLength(2);
      expect(workerApiClient.searchPage).toHaveBeenCalledTimes(1);
      expect(workerApiClient.getPeople).toHaveBeenCalledTimes(1);
      expect(workerApiClient.getKnownPeople).toHaveBeenCalledTimes(1);
      expect(workerApiClient.getAlbums).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no spans until 150 ms after the last keystroke, and none under 3 characters', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderHook(({ t }) => useOmniboxData(t, none), { wrapper, initialProps: { t: '' } });
      await loaded(result);
      rerender({ t: 'ca' });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(result.current.spans).toEqual([]);
      rerender({ t: 'carl' });
      expect(result.current.spans).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(result.current.spans).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(result.current.spans).toHaveLength(1);
      expect(result.current.spans[0].matches[0].id).toBe('Q2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an own and a known entry for the same name', async () => {
    const { result } = renderHook(() => useOmniboxData('', none), { wrapper });
    await loaded(result);
    const kinds = result.current.candidates.filter((c) => c.label === 'Anita Rao').map((c) => c.kind).sort();
    expect(kinds).toEqual(['known', 'own']);
  });

  it('omits albums while an album is selected and excludes selected people', async () => {
    const sel = { ...none, album: 'Goa Trip', people: ['p1'], known: ['Q2'] };
    const { result } = renderHook(() => useOmniboxData('', sel), { wrapper });
    await loaded(result);
    const keys = result.current.candidates.map((c) => `${c.kind}:${c.id}`);
    expect(keys).not.toContain('album:Goa Trip');
    expect(keys).not.toContain('own:p1');
    expect(keys).not.toContain('known:Q2');
    expect(keys).toContain('own:p2');
    expect(result.current.labelFor('own', 'p1')).toBe('Anita Rao');
    expect(result.current.labelFor('known', 'Q2')).toBe('Carl Moon');
    expect(result.current.labelFor('album', 'Goa Trip')).toBe('Goa Trip');
    expect(result.current.labelFor('own', 'zzz')).toBeNull();
  });

  it('labelFor is null before the lists load', () => {
    const { result } = renderHook(() => useOmniboxData('', none), { wrapper });
    expect(result.current.labelFor('own', 'p1')).toBeNull();
  });

  it('fires exactly one limit-1 search for two person spans and returns its total', async () => {
    const sel = { ...none, album: 'Goa Trip', from: '2020-01-01', to: '', onThisDay: '' };
    const { result } = renderHook(() => useOmniboxData('bob stone carl moon', sel), { wrapper });
    await waitFor(() => expect(result.current.bothCount?.total).toBe(7));
    expect(result.current.bothCount?.ids.map((c) => `${c.kind}:${c.id}`)).toEqual(['own:p2', 'known:Q2']);
    expect(workerApiClient.searchPage).toHaveBeenCalledTimes(1);
    expect(workerApiClient.searchPage).toHaveBeenCalledWith({
      people: ['p2'],
      known: ['Q2'],
      album: 'Goa Trip',
      from: '2020-01-01',
      limit: 1,
    });
  });

  it('has no both count for one person span or when the cap would be exceeded', async () => {
    const one = renderHook(() => useOmniboxData('bob stone', none), { wrapper });
    await waitFor(() => expect(one.result.current.spans).toHaveLength(1));
    expect(one.result.current.bothCount).toBeNull();

    const sel = { ...none, people: ['a', 'b', 'c', 'd'] };
    const capped = renderHook(() => useOmniboxData('bob stone carl moon', sel), { wrapper });
    await waitFor(() => expect(capped.result.current.spans).toHaveLength(2));
    expect(capped.result.current.bothCount).toBeNull();
    expect(workerApiClient.searchPage).not.toHaveBeenCalled();
  });

  it('offers the both count at exactly the cap (3 selected + 2 new = 5) and not above it (3 + 3 = 6)', async () => {
    const sel = { ...none, people: ['x1', 'x2', 'x3'] };
    const at = renderHook(() => useOmniboxData('bob stone carl moon', sel), { wrapper });
    await waitFor(() => expect(at.result.current.bothCount?.total).toBe(7));
    expect(workerApiClient.searchPage).toHaveBeenCalledWith({
      people: ['x1', 'x2', 'x3', 'p2'],
      known: ['Q2'],
      limit: 1,
    });
    vi.mocked(workerApiClient.searchPage).mockClear();
    const over = renderHook(() => useOmniboxData('anita rao bob stone carl moon', sel), { wrapper });
    await waitFor(() => expect(over.result.current.spans).toHaveLength(3));
    expect(over.result.current.bothCount).toBeNull();
    expect(workerApiClient.searchPage).not.toHaveBeenCalled();
  });

  it('caches the both count and re-keys it when the selected album changes', async () => {
    const { result, rerender } = renderHook(({ t, s }) => useOmniboxData(t, s), {
      wrapper,
      initialProps: { t: 'bob stone carl moon', s: none },
    });
    await waitFor(() => expect(result.current.bothCount?.total).toBe(7));
    rerender({ t: 'bob stone carl moon', s: { ...none } });
    // Different typed text, same two people: the typed text is not part of the count, so no new request.
    rerender({ t: 'bob stone carl moon zzzz', s: none });
    await waitFor(() => expect(result.current.spans).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 250));
    expect(workerApiClient.searchPage).toHaveBeenCalledTimes(1);
    rerender({ t: 'bob stone carl moon', s: { ...none, album: 'Goa Trip' } });
    await waitFor(() => expect(workerApiClient.searchPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(workerApiClient.searchPage).mock.calls[1][0]).toMatchObject({ album: 'Goa Trip' });
  });
});
