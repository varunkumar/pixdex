import { usePageTitle } from '../hooks/usePageTitle';
import { Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { IconType } from 'react-icons';
import { TbCalendar, TbHash, TbStar } from 'react-icons/tb';
import { useRememberAddress } from '../hooks/useLastAddress';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient, type AlbumSort } from '../services/api/WorkerApiClient';
import AlbumCard from './AlbumCard';
import ListPagination from './ListPagination';
import PageLoading from './PageLoading';
import SortIcons from './SortIcons';

const ALBUM_PAGE_SIZES = [12, 24, 48] as const;

const SORT_OPTIONS: { value: AlbumSort; label: string; icon?: IconType; text?: string }[] = [
  { value: 'date', label: 'Newest first', icon: TbCalendar },
  { value: 'rating', label: 'Best rated', icon: TbStar },
  { value: 'name', label: 'Alphabetical', text: 'A-Z' },
  { value: 'count', label: 'Most photos', icon: TbHash },
];

const Albums = () => {
  useRememberAddress();
  usePageTitle('Albums');
  const { params, page, size, offset, update } = useListParams(12, ALBUM_PAGE_SIZES);

  const requestedSort = params.get('sort');
  const sort = SORT_OPTIONS.find((o) => o.value === requestedSort)?.value ?? 'date';

  const { data, error, isPlaceholderData } = useQuery({
    queryKey: ['albums-page', page, size, sort],
    queryFn: () => workerApiClient.getAlbumsPage({ limit: size, offset, sort }),
    placeholderData: keepPreviousData,
  });

  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center">
        <Title order={1} size="h2">Albums</Title>
        <SortIcons
          label="Sort albums"
          options={SORT_OPTIONS}
          value={sort}
          onChange={(value) => update({ sort: value === 'date' ? null : value }, { resetPage: true })}
        />
      </Group>

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
      {!data && !error && <PageLoading label="Loading albums" />}
      {data && data.albums.length === 0 && <Text c="dimmed">No albums yet.</Text>}

      {data && data.albums.length > 0 && (
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }} spacing="md">
          {data.albums.map((album) => (
            <AlbumCard key={album.name} album={album} />
          ))}
        </SimpleGrid>
      )}

      {data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          settled={!isPlaceholderData}
          sizes={ALBUM_PAGE_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default Albums;
