import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';

const ALBUM_PHOTO_SIZES = [12, 24, 48] as const;

const AlbumPhotos = () => {
  const { name = '' } = useParams();
  const { params, page, size, offset, update } = useListParams(12, ALBUM_PHOTO_SIZES);

  const { data, error } = useQuery({
    queryKey: ['album-photos', name, page, size],
    queryFn: () => workerApiClient.searchPage({ album: name, sort: 'date', limit: size, offset }),
    enabled: name !== '',
    placeholderData: keepPreviousData,
  });

  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  return (
    <Stack gap="lg">
      <Anchor component={Link} to="/albums" size="sm">
        ← All albums
      </Anchor>
      <Group justify="space-between" align="baseline">
        <Title order={2}>{name}</Title>
        {data && (
          <Text c="dimmed">
            {data.total} {data.total === 1 ? 'photo' : 'photos'}
          </Text>
        )}
      </Group>

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
      {data && data.results.length === 0 && <Text c="dimmed">This album has no photos.</Text>}
      {data && data.results.length > 0 && <PhotoGrid photos={data.results} />}

      {data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          sizes={ALBUM_PHOTO_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default AlbumPhotos;
