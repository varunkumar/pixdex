import { Button, Card, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { MdSearch } from 'react-icons/md';
import { PAGE_SIZES, useListParams } from '../hooks/useListParams';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';

const SORT_OPTIONS: { value: PhotoSort | 'relevance'; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'rating', label: 'Best rated' },
  { value: 'date', label: 'Newest first' },
  { value: 'name', label: 'Alphabetical' },
];

const Search = () => {
  const { params, page, size, offset, update } = useListParams();
  const rawQ = params.get('q') ?? '';
  const q = rawQ.trim();
  const album = params.get('album') ?? '';
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

  // No term and no album means nothing to look for: show a prompt, not the whole library.
  const hasCriteria = q !== '' || album !== '';

  const { data, isFetching, error, isPlaceholderData } = useQuery({
    queryKey: ['search', q, album, page, size, sort],
    queryFn: () =>
      workerApiClient.searchPage({ q, album, sort: sort === 'relevance' ? undefined : sort, limit: size, offset }),
    enabled: hasCriteria,
    placeholderData: keepPreviousData,
  });

  const submit = () => update({ q: text.trim() }, { resetPage: true });
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
      </Card>

      {!hasCriteria && <Text c="dimmed">Enter a search term or pick an album to find photos.</Text>}

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
