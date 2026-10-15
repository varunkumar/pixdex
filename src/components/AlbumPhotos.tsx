import { Anchor, Button, Group, Select, Stack, Text, Title } from '@mantine/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';

const ALBUM_PHOTO_SIZES = [12, 24, 48] as const;

const SORT_OPTIONS: { value: PhotoSort; label: string }[] = [
  { value: 'date', label: 'Newest first' },
  { value: 'rating', label: 'Best rated' },
  { value: 'name', label: 'Alphabetical' },
];

const AlbumPhotos = () => {
  const { name = '' } = useParams();
  const { params, page, size, offset, update } = useListParams(12, ALBUM_PHOTO_SIZES);

  const requestedSort = params.get('sort');
  const sort = SORT_OPTIONS.find((o) => o.value === requestedSort)?.value ?? 'date';
  const queryClient = useQueryClient();

  const { data, error, isPlaceholderData } = useQuery({
    queryKey: ['album-photos', name, page, size, sort],
    queryFn: () => workerApiClient.searchPage({ album: name, sort, limit: size, offset }),
    enabled: name !== '',
    placeholderData: keepPreviousData,
  });

  const { data: summary } = useQuery({
    queryKey: ['album-summary', name],
    queryFn: async () => (await workerApiClient.getAlbumsPage({ limit: 1, name })).albums[0] ?? null,
    enabled: name !== '',
  });
  const coverId = summary?.coverPhotoId;

  const setCover = useMutation({
    mutationFn: (photoId: string) => workerApiClient.setAlbumCover(name, photoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['album-summary', name] });
      void queryClient.invalidateQueries({ queryKey: ['albums-page'] });
    },
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
        <Group gap="md" align="center">
          {data && (
            <Text c="dimmed">
              {data.total} {data.total === 1 ? 'photo' : 'photos'}
            </Text>
          )}
          <Select
            aria-label="Sort photos"
            data={SORT_OPTIONS}
            value={sort}
            allowDeselect={false}
            w={170}
            onChange={(value) => update({ sort: value === 'date' ? null : value }, { resetPage: true })}
          />
        </Group>
      </Group>
      {setCover.error && (
        <Text c="red">{setCover.error instanceof Error ? setCover.error.message : 'Could not set cover'}</Text>
      )}

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
      {data && data.results.length === 0 && <Text c="dimmed">This album has no photos.</Text>}
      {data && data.results.length > 0 && (
        <PhotoGrid
          photos={data.results}
          footer={(photo) => (
            <Button
              variant="light"
              size="xs"
              w="fit-content"
              disabled={photo.id === coverId}
              loading={setCover.isPending && setCover.variables === photo.id}
              onClick={() => setCover.mutate(photo.id)}
            >
              {photo.id === coverId ? 'Album cover' : 'Set as cover'}
            </Button>
          )}
        />
      )}

      {data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          settled={!isPlaceholderData}
          sizes={ALBUM_PHOTO_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default AlbumPhotos;
