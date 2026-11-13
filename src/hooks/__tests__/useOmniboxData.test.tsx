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

const wrapper = ({ children }: { children: ReactNode }) => (
  <MantineProvider>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  </MantineProvider>
);

const none: OmniboxSelection = { album: '', people: [], known: [], from: '', to: '', onThisDay: '' };
const person = (id: string, name: string | null, photoCount = 5) => ({
  id, name, faceCount: 1, photoCount, canEdit: true, cover: null,
});

beforeEach(() => {
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
  it('loads each list once across several text changes and never searches while typing', async () => {
    const { result, rerender } = renderHook(({ t }) => useOmniboxData(t, none), { wrapper, initialProps: { t: '' } });
    await loaded(result);
    for (const t of ['a', 'ani', 'anita', 'anita r']) rerender({ t });
    await waitFor(() => expect(result.current.spans.length).toBe(1));
    expect(workerApiClient.getPeople).toHaveBeenCalledTimes(1);
    expect(workerApiClient.getKnownPeople).toHaveBeenCalledTimes(1);
    expect(workerApiClient.getAlbums).toHaveBeenCalledTimes(1);
    expect(workerApiClient.searchPage).not.toHaveBeenCalled();
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
});
