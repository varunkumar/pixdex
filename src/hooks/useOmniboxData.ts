import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { candidateKey, splitSpans, type Candidate, type CandidateKind, type Span } from '../services/omnibox/matcher';
import { personOptions } from '../services/peopleKeys';
import { MAX_PEOPLE_FILTER } from '../services/peopleSelection';

const FIVE_MINUTES = 5 * 60 * 1000;
const DEBOUNCE_MS = 150;

export interface OmniboxSelection {
  album: string;
  people: string[];
  known: string[];
  from: string;
  to: string;
  onThisDay: string;
}

/**
 * Candidate lists (shared query keys with PeopleFilter and Timeline, so one request each per 5 minutes), debounced
 * spans, and the "Add both" count. Typing alone never makes a request; the only extra request is one limit-1 search
 * when two person spans are shown (cached, keyed by the ids and the selection).
 */
export function useOmniboxData(text: string, selection: OmniboxSelection) {
  const { data: own = [], isSuccess: peopleLoaded } = useQuery({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
    staleTime: FIVE_MINUTES,
  });
  const { data: knownList = [], isSuccess: knownLoaded } = useQuery({
    queryKey: ['known-people'],
    queryFn: () => workerApiClient.getKnownPeople(),
    staleTime: FIVE_MINUTES,
  });
  const { data: albumNames = [], isSuccess: albumsLoaded } = useQuery({
    queryKey: ['album-names'],
    queryFn: () => workerApiClient.getAlbums(),
    staleTime: FIVE_MINUTES,
  });

  const { album, people, known, from, to, onThisDay } = selection;
  const peopleKey = people.join(',');
  const knownKey = known.join(',');

  const all = useMemo<Candidate[]>(() => {
    const labels = personOptions(own);
    const ownC: Candidate[] = own.map((p, i) => ({
      kind: 'own',
      id: p.id,
      label: labels[i].label,
      aliases: [],
      photoCount: p.photoCount,
    }));
    const knownC: Candidate[] = knownList.map((k) => ({
      kind: 'known',
      id: k.id,
      label: k.name,
      aliases: k.aliases,
      photoCount: k.photoCount,
    }));
    const albumC: Candidate[] = albumNames.map((a) => ({ kind: 'album', id: a, label: a, aliases: [], photoCount: 0 }));
    return [...ownC, ...knownC, ...albumC];
  }, [own, knownList, albumNames]);

  const candidates = useMemo(() => {
    const picked = new Set([...people.map((id) => `own:${id}`), ...known.map((id) => `known:${id}`)]);
    return all.filter((c) => {
      if (c.kind === 'album') return album === '';
      return !picked.has(candidateKey(c));
    });
    // peopleKey and knownKey stand in for the arrays
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, album, peopleKey, knownKey]);

  const labelFor = (kind: CandidateKind, id: string): string | null =>
    all.find((c) => c.kind === kind && c.id === id)?.label ?? null;

  const [debounced] = useDebouncedValue(text, DEBOUNCE_MS);
  const spans = useMemo<Span[]>(() => splitSpans(debounced, candidates).spans, [debounced, candidates]);

  const tops = spans.filter((s) => s.matches[0].kind !== 'album').map((s) => s.matches[0]);
  const bothShown = tops.length >= 2 && people.length + known.length + tops.length <= MAX_PEOPLE_FILTER;
  const bothIds = bothShown ? tops : [];

  const newOwn = bothIds.filter((c) => c.kind === 'own').map((c) => c.id);
  const newKnown = bothIds.filter((c) => c.kind === 'known').map((c) => c.id);
  const allPeople = [...people, ...newOwn];
  const allKnown = [...known, ...newKnown];

  const { data: total } = useQuery({
    queryKey: ['omnibox-both', allPeople.join(','), allKnown.join(','), album, from, to, onThisDay],
    queryFn: async () => {
      const res = await workerApiClient.searchPage({
        ...(allPeople.length > 0 && { people: allPeople }),
        ...(allKnown.length > 0 && { known: allKnown }),
        ...(album !== '' && { album }),
        ...(from !== '' && { from }),
        ...(to !== '' && { to }),
        ...(onThisDay !== '' && { onThisDay }),
        limit: 1,
      });
      return res.total ?? null;
    },
    staleTime: FIVE_MINUTES,
    enabled: bothShown,
  });

  const bothCount = bothShown ? { ids: bothIds, total: total ?? null } : null;

  return { candidates, labelFor, spans, bothCount, listsLoaded: { people: peopleLoaded, known: knownLoaded, albums: albumsLoaded } };
}
