import { Alert, Button, Card, Chip, Group, Loader, Select, Stack, Switch, Text } from '@mantine/core';
import { DatePickerInput, type DatesRangeValue } from '@mantine/dates';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MdSearch } from 'react-icons/md';
import { Navigate, useSearchParams } from 'react-router-dom';
import { PAGE_SIZES, useListParams } from '../hooks/useListParams';
import type { OmniboxSelection } from '../hooks/useOmniboxData';
import { usePromptApiSupport } from '../hooks/usePromptApiSupport';
import { runAiSearch, type AiFilters } from '../services/aiSearch/pipeline';
import { expandRequest } from '../services/aiSearch/promptApi';
import { normalizeKeywords } from '../services/aiSearch/ranking';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import { onThisDayToday, parseDateQuery, quickRange } from '../services/dateQuery';
import { readOmniboxState, stripAiParams } from '../services/omnibox/urlState';
import { parsePeopleSelection } from '../services/peopleSelection';
import AiResults from './AiResults';
import ListPagination from './ListPagination';
import Omnibox from './omnibox/Omnibox';
import PhotoGrid from './PhotoGrid';

const SORT_OPTIONS: { value: PhotoSort | 'relevance'; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'rating', label: 'Best rated' },
  { value: 'date', label: 'Newest first' },
  { value: 'name', label: 'Alphabetical' },
];

const QUICK_CHIPS = [
  { kind: 'today', label: 'Today' },
  { kind: 'week', label: 'This week' },
  { kind: 'month', label: 'This month' },
  { kind: 'year', label: 'This year' },
] as const;

type Patch = Record<string, string | null | undefined>;

// Mantine 9 hands back local `YYYY-MM-DD` strings; format a Date locally (never toISOString) just in case.
const toYmd = (v: string | Date | null): string | null => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'An error occurred');

/**
 * One page for plain and AI search. The URL is the source of truth: `q` is the plain text (or the AI request),
 * `mode=ai` with `kw` selects AI mode, and album, people, known and dates are chips in the bar that filter both.
 */
const Search = () => {
  const { params, page, size, offset, update } = useListParams();
  const [, setParams] = useSearchParams();
  const support = usePromptApiSupport();
  const state = readOmniboxState(params);
  const ai = state.mode === 'ai';
  const rawQ = state.q;
  const q = rawQ.trim();
  const terms = ai ? normalizeKeywords(state.kw) : [];
  const album = params.get('album') ?? '';
  const { people, known } = parsePeopleSelection(params.get('people'), params.get('known'));
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const onThisDay = params.get('onThisDay') ?? '';
  const peopleKey = people.join(',');
  const knownKey = known.join(',');
  const sort = (SORT_OPTIONS.find((o) => o.value === params.get('sort'))?.value ?? 'relevance') as PhotoSort | 'relevance';
  const [text, setText] = useState(rawQ);
  const [syncedQ, setSyncedQ] = useState(rawQ);

  // Keep the box in step with the URL (back/forward, deep links).
  if (syncedQ !== rawQ) {
    setSyncedQ(rawQ);
    setText(rawQ);
  }

  // Writes that may land after other URL changes (the expansion finishes later) build on the latest committed
  // params, never this render's snapshot: React Router's functional setSearchParams also closes over its render,
  // so a ref is the only way a switch flipped while the model runs is not undone when it completes.
  const latestParams = useRef(params);
  useEffect(() => {
    latestParams.current = params;
  }, [params]);
  const patchLatest = (patch: Patch) => {
    const next = new URLSearchParams(latestParams.current);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    next.delete('page');
    setParams(next);
  };

  // Plain mode: no term, album, person or date means nothing to look for, so show a prompt, not the whole library.
  const hasCriteria = q !== '' || album !== '' || people.length > 0 || known.length > 0 || from !== '' || to !== '' || onThisDay !== '';

  const { data, isFetching, error, isPlaceholderData } = useQuery({
    queryKey: ['search', q, album, peopleKey, knownKey, from, to, onThisDay, page, size, sort],
    queryFn: () =>
      workerApiClient.searchPage({
        q,
        album,
        ...(people.length > 0 && { people }),
        ...(known.length > 0 && { known }),
        ...(from && { from }),
        ...(to && { to }),
        ...(onThisDay && { onThisDay }),
        sort: sort === 'relevance' ? undefined : sort,
        limit: size,
        offset,
      }),
    enabled: !ai && hasCriteria,
    placeholderData: keepPreviousData,
  });

  // AI mode. Filtering by a person while hiding people photos is contradictory, so a people or known chip turns
  // hiding off for the pipeline (the URL value stays for when the chips go).
  const personChips = people.length > 0 || known.length > 0;
  const hidePeople = state.hidePeople && !personChips;
  const leaveRoom = state.leaveRoom;
  const filters: AiFilters = { album, people, known, from, to, onThisDay };
  const aiSearch = useQuery({
    queryKey: ['ai-search', terms, hidePeople, leaveRoom, album, peopleKey, knownKey, from, to, onThisDay],
    queryFn: () => runAiSearch(terms, { hidePeople, leaveRoom }, undefined, filters),
    enabled: ai && support === 'supported' && terms.length > 0,
  });

  const [status, setStatus] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);

  const expansion = useMutation({
    mutationFn: (request: string) => expandRequest(request, setStatus),
    onMutate: () => {
      const t = Date.now();
      setStatus('Starting the on-device model');
      setStartedAt(t);
      setNow(t);
    },
  });

  useEffect(() => {
    if (!expansion.isPending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expansion.isPending]);

  // Bumped by every explicit write that sets q or leaves AI mode (Enter, a pick that trims the text, a keyword
  // write). An expansion that finishes after one of those is stale and must not undo it. The mutation is never
  // reset for this, so a second Ask AI still cannot start while the model runs.
  const generation = useRef(0);
  const bump = () => {
    generation.current += 1;
  };

  const askAi = () => {
    // Never parsed for dates: the whole text is the request.
    const request = text.trim();
    if (!request || expansion.isPending) return;
    // Only a successful expansion replaces the keywords; an error leaves the URL as it was.
    // A per-call onSuccess does not fire after unmount, so leaving mid-run cannot navigate back here.
    const started = generation.current;
    expansion.mutate(request, {
      onSuccess: (result) => {
        if (generation.current !== started) return;
        patchLatest({ mode: 'ai', q: request, kw: result.keywords.join(',') });
      },
    });
  };

  // The keyword row may call onChange and then onSearchAgain in one event, both seeing this render's terms;
  // remember the value already written so the second call does not push a duplicate history entry.
  const writtenKw = useRef<string | null>(null);
  const writeKw = (next: string[]) => {
    const kw = normalizeKeywords(next.join(',')).join(',');
    writtenKw.current = kw;
    bump();
    patchLatest({ mode: 'ai', kw });
  };
  const searchAgain = (next: string[]) => {
    // Resetting a pending expansion would hide it and let Ask AI run twice.
    if (expansion.isError) expansion.reset();
    const kw = normalizeKeywords(next.join(',')).join(',');
    const current = terms.join(',');
    if (ai && kw === current) {
      if (kw) void aiSearch.refetch();
    } else if (kw !== writtenKw.current) {
      writtenKw.current = kw;
      bump();
      patchLatest({ mode: 'ai', kw });
    }
    writtenKw.current = null;
  };

  const submit = () => {
    bump();
    const parsed = parseDateQuery(text);
    // A typed date wins over the picker; with none typed, the picker stays as it is. Enter always leaves AI mode.
    update(
      { q: parsed.text, ...(parsed.from && { from: parsed.from, to: parsed.to, onThisDay: null }), mode: null, kw: null },
      { resetPage: true }
    );
  };

  // A half-picked range (first click) stays local; the URL only ever gets complete ranges.
  const [pending, setPending] = useState<DatesRangeValue | null>(null);

  // One URL update per pick: the selection patch and the trimmed text together.
  const onSelection = (patch: Partial<OmniboxSelection>, nextText?: string) => {
    const next: Patch = {};
    if (patch.album !== undefined) next.album = patch.album;
    if (patch.people !== undefined) next.people = patch.people.join(',');
    if (patch.known !== undefined) next.known = patch.known.join(',');
    if (patch.from !== undefined) next.from = patch.from;
    if (patch.to !== undefined) next.to = patch.to;
    if (patch.onThisDay !== undefined) next.onThisDay = patch.onThisDay;
    if (patch.from !== undefined || patch.to !== undefined || patch.onThisDay !== undefined) setPending(null);
    if (nextText !== undefined) {
      bump();
      next.q = nextText;
      setText(nextText);
    }
    update(next, { resetPage: true });
  };

  const setRange = ([a, b]: DatesRangeValue) => {
    if (a && !b) {
      setPending([a, null]);
      return;
    }
    setPending(null);
    update({ from: toYmd(a), to: toYmd(b), onThisDay: null }, { resetPage: true });
  };
  const today = new Date();
  const toggleQuick = (kind: (typeof QUICK_CHIPS)[number]['kind'], active: boolean) => {
    setPending(null);
    update(active ? { from: null, to: null } : { ...quickRange(kind, today), onThisDay: null }, { resetPage: true });
  };
  const toggleOnThisDay = (active: boolean) => {
    setPending(null);
    update(active ? { onThisDay: null } : { onThisDay: onThisDayToday(today), from: null, to: null }, { resetPage: true });
  };
  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  // AI mode never renders without the Prompt API: drop its params and fall back to a plain search.
  if (ai && support === 'unsupported') {
    const rest = stripAiParams(params).toString();
    return <Navigate to={{ search: rest ? `?${rest}` : '' }} replace />;
  }
  if (ai && support === 'checking') return <Loader />;

  const supported = support === 'supported';
  const showKeywords = supported && (ai || expansion.isError);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <Stack gap="lg">
      {/* Card clips its content by default; visible so the suggestion panel can hang below it. */}
      <Card withBorder style={{ overflow: 'visible' }} data-testid="search-card">
        <Stack gap="md">
          <Omnibox
            text={text}
            onText={setText}
            selection={{ album, people, known, from, to, onThisDay }}
            onSelection={onSelection}
            onSubmit={submit}
            onAskAi={supported ? askAi : undefined}
            askAiBusy={expansion.isPending}
            keywordChips={showKeywords ? { terms, onChange: writeKw, onSearchAgain: searchAgain } : undefined}
          />

          {expansion.isPending && (
            <Group gap="xs" aria-live="polite">
              <Loader size="xs" />
              <Text size="sm">{status}</Text>
              <Text size="sm" c="dimmed">
                Running on this device, {elapsed}s
              </Text>
            </Group>
          )}

          {expansion.isError && (
            <Alert color="red" title="The on-device model did not produce keywords">
              <Text size="sm">{errorMessage(expansion.error)}</Text>
              <Text size="sm" c="dimmed">
                You can add keywords below the search box and search anyway.
              </Text>
            </Alert>
          )}

          <Group gap="md" align="flex-end">
            <DatePickerInput
              type="range"
              label="Dates"
              placeholder="Any date"
              valueFormat="D MMM YYYY"
              value={pending ?? [from || null, to || null]}
              onChange={setRange}
              clearable
              clearButtonProps={{ 'aria-label': 'Clear dates' }}
            />
            <Group gap="xs">
              {QUICK_CHIPS.map(({ kind, label }) => {
                const r = quickRange(kind, today);
                const active = onThisDay === '' && from === r.from && to === r.to;
                return (
                  <Chip key={kind} checked={active} onChange={() => toggleQuick(kind, active)}>
                    {label}
                  </Chip>
                );
              })}
              <Chip checked={onThisDay !== ''} onChange={() => toggleOnThisDay(onThisDay !== '')}>
                On this day
              </Chip>
            </Group>
            {!ai && (
              <Select
                label="Sort by"
                aria-label="Sort results"
                data={SORT_OPTIONS}
                value={sort}
                allowDeselect={false}
                onChange={(value) => update({ sort: value === 'relevance' ? null : value }, { resetPage: true })}
              />
            )}
            {ai && (
              <Group gap="lg">
                {!personChips && (
                  <Switch
                    label="Hide people photos"
                    checked={state.hidePeople}
                    onChange={(e) => update({ hidePeople: e.currentTarget.checked ? null : '0' }, { resetPage: true })}
                  />
                )}
                <Switch
                  label="Leave room for text"
                  checked={leaveRoom}
                  onChange={(e) => update({ room: e.currentTarget.checked ? null : '0' }, { resetPage: true })}
                />
              </Group>
            )}
            <Button
              onClick={submit}
              leftSection={!ai && hasCriteria && isFetching ? <Loader size="xs" color="white" /> : <MdSearch />}
            >
              Search
            </Button>
          </Group>
        </Stack>
      </Card>

      {!ai && !hasCriteria && (
        <Text c="dimmed">Enter a search term or pick an album, person or date to find photos.</Text>
      )}

      {!ai && hasCriteria && error && <Text c="red">{errorMessage(error)}</Text>}

      {!ai && hasCriteria && data && data.results.length === 0 && <Text c="dimmed">No photos match your search.</Text>}

      {!ai && hasCriteria && data && data.results.length > 0 && <PhotoGrid photos={data.results} />}

      {!ai && hasCriteria && data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          settled={!isPlaceholderData}
          sizes={PAGE_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}

      {ai && terms.length === 0 && !expansion.isPending && (
        <Text c="dimmed">Describe what the photos are for and press Ask AI, or add keywords, to find photos.</Text>
      )}

      {ai && terms.length > 0 && aiSearch.isPending && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text c="dimmed">Searching and measuring text space...</Text>
        </Group>
      )}

      {ai && terms.length > 0 && aiSearch.isError && <Text c="red">{errorMessage(aiSearch.error)}</Text>}

      {ai && terms.length > 0 && aiSearch.data && <AiResults result={aiSearch.data} />}
    </Stack>
  );
};

export default Search;
