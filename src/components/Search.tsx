import { Button, Card, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { MdSearch } from 'react-icons/md';
import { PAGE_SIZES, useListParams } from '../hooks/useListParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';

const Search = () => {
  const { params, page, size, offset, update } = useListParams();
  const rawQ = params.get('q') ?? '';
  const q = rawQ.trim();
  const album = params.get('album') ?? '';
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

  const { data, isFetching, error } = useQuery({
    queryKey: ['search', q, album, page, size],
    queryFn: () => workerApiClient.searchPage({ q, album, limit: size, offset }),
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
            leftSection={isFetching ? <Loader size="xs" color="white" /> : <MdSearch />}
            style={{ flexGrow: 0 }}
          >
            Search
          </Button>
        </Group>
      </Card>

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}

      {data && data.results.length === 0 && <Text c="dimmed">No photos match your search.</Text>}

      {data && data.results.length > 0 && <PhotoGrid photos={data.results} />}

      {data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          sizes={PAGE_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default Search;
