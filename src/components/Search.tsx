import { Button, Card, Chip, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { DatePickerInput, type DatesRangeValue } from '@mantine/dates';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { MdSearch } from 'react-icons/md';
import { PAGE_SIZES, useListParams } from '../hooks/useListParams';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import { onThisDayToday, parseDateQuery, quickRange } from '../services/dateQuery';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';
import { parsePeopleSelection } from '../services/peopleSelection';
import PeopleFilter from './PeopleFilter';

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

// Mantine 9 hands back local `YYYY-MM-DD` strings; format a Date locally (never toISOString) just in case.
const toYmd = (v: string | Date | null): string | null => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

const Search = () => {
  const { params, page, size, offset, update } = useListParams();
  const rawQ = params.get('q') ?? '';
  const q = rawQ.trim();
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

  const { data: albums = [] } = useQuery({
    queryKey: ['album-names'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  // No term, album or person means nothing to look for: show a prompt, not the whole library.
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
    enabled: hasCriteria,
    placeholderData: keepPreviousData,
  });

  const submit = () => {
    const parsed = parseDateQuery(text);
    // A typed date wins over the picker; with none typed, the picker stays as it is.
    update(
      { q: parsed.text, ...(parsed.from && { from: parsed.from, to: parsed.to, onThisDay: null }) },
      { resetPage: true }
    );
  };
  // A half-picked range (first click) stays local; the URL only ever gets complete ranges.
  const [pending, setPending] = useState<DatesRangeValue | null>(null);
  const setRange = ([a, b]: DatesRangeValue) => {
    if (a && !b) {
      setPending([a, null]);
      return;
    }
    setPending(null);
    update({ from: toYmd(a), to: toYmd(b), onThisDay: null }, { resetPage: true });
  };
  const now = new Date();
  const toggleQuick = (kind: (typeof QUICK_CHIPS)[number]['kind'], active: boolean) => {
    setPending(null);
    update(active ? { from: null, to: null } : { ...quickRange(kind, now), onThisDay: null }, { resetPage: true });
  };
  const toggleOnThisDay = (active: boolean) => {
    setPending(null);
    update(active ? { onThisDay: null } : { onThisDay: onThisDayToday(now), from: null, to: null }, { resetPage: true });
  };
  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  return (
    <Stack gap="lg">
      <Card withBorder>
        <Group align="flex-end" gap="md" grow preventGrowOverflow={false}>
          <Select
            label="Album"
            aria-label="Select photo album"
            placeholder="All albums"
            data={albums}
            value={album || null}
            onChange={(value) => update({ album: value }, { resetPage: true })}
            clearable
            searchable
          />
          <PeopleFilter
            people={people}
            known={known}
            onChange={(next) =>
              update({ people: next.people.join(','), known: next.known.join(',') }, { resetPage: true })
            }
          />
          <Select
            label="Sort by"
            aria-label="Sort results"
            data={SORT_OPTIONS}
            value={sort}
            allowDeselect={false}
            onChange={(value) => update({ sort: value === 'relevance' ? null : value }, { resetPage: true })}
          />
          <TextInput
            label="Search"
            placeholder="Search photos..."
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button
            onClick={submit}
            leftSection={hasCriteria && isFetching ? <Loader size="xs" color="white" /> : <MdSearch />}
            style={{ flexGrow: 0 }}
          >
            Search
          </Button>
        </Group>
        <Group mt="md" gap="md" align="flex-end">
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
              const r = quickRange(kind, now);
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
        </Group>
      </Card>

      {!hasCriteria && <Text c="dimmed">Enter a search term or pick an album, person or date to find photos.</Text>}

      {hasCriteria && error && (
        <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>
      )}

      {hasCriteria && data && data.results.length === 0 && (
        <Text c="dimmed">No photos match your search.</Text>
      )}

      {hasCriteria && data && data.results.length > 0 && <PhotoGrid photos={data.results} />}

      {hasCriteria && data && (
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
    </Stack>
  );
};

export default Search;
