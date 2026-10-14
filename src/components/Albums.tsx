import { SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import AlbumCard from './AlbumCard';
import ListPagination from './ListPagination';

const ALBUM_PAGE_SIZES = [12, 24, 48] as const;

const Albums = () => {
  const { params, page, size, offset, update } = useListParams(12, ALBUM_PAGE_SIZES);

  const { data, error, isPlaceholderData } = useQuery({
    queryKey: ['albums-page', page, size],
    queryFn: () => workerApiClient.getAlbumsPage({ limit: size, offset }),
    placeholderData: keepPreviousData,
  });

  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  return (
    <Stack gap="lg">
      <Title order={2}>Albums</Title>

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
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
