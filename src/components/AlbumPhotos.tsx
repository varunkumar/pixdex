import { Badge, Button, Group, Stack, Tabs, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { IconType } from 'react-icons';
import { TbCalendar, TbStar } from 'react-icons/tb';
import { useParams } from 'react-router-dom';
import { useLastAddress } from '../hooks/useLastAddress';
import { useListParams } from '../hooks/useListParams';
import { filterPatch, parseAlbumFilter, type AlbumFilter } from '../services/albumFilter';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import { photoCaption } from '../services/text';
import AlbumFilterChip from './AlbumFilterChip';
import AlbumHero from './AlbumHero';
import BackLink from './BackLink';
import { PeopleTiles, SpeciesTiles } from './AlbumTiles';
import ColumnsToggle from './ColumnsToggle';
import CoverBadge from './CoverBadge';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';
import SetCoverButton from './SetCoverButton';
import ShareAlbumModal from './ShareAlbumModal';
import SortIcons from './SortIcons';
import { AvatarStack, UserAvatar } from './UserAvatar';

const ALBUM_PHOTO_SIZES = [12, 24, 48] as const;

const SORT_OPTIONS: { value: PhotoSort; label: string; icon?: IconType; text?: string }[] = [
  { value: 'date', label: 'Newest first', icon: TbCalendar },
  { value: 'rating', label: 'Best rated', icon: TbStar },
  { value: 'name', label: 'Alphabetical', text: 'A-Z' },
];

const AlbumPhotos = () => {
  const { name = '' } = useParams();
  const albumsList = useLastAddress('/albums');
  const { params, page, size, offset, update } = useListParams(12, ALBUM_PHOTO_SIZES);

  const requestedSort = params.get('sort');
  const sort = SORT_OPTIONS.find((o) => o.value === requestedSort)?.value ?? 'date';
  const queryClient = useQueryClient();

  // One filter at a time from the URL (people, then known, then species).
  const filter = useMemo(() => parseAlbumFilter(params), [params]);

  const { data, error, isPlaceholderData } = useQuery({
    queryKey: ['album-photos', name, page, size, sort, filter?.kind ?? null, filter?.value ?? null],
    queryFn: () =>
      workerApiClient.searchPage({
        album: name,
        ...(filter?.kind === 'people' && { people: [filter.value] }),
        ...(filter?.kind === 'known' && { known: [filter.value] }),
        ...(filter?.kind === 'species' && { species: filter.value }),
        sort,
        limit: size,
        offset,
      }),
    enabled: name !== '',
    placeholderData: keepPreviousData,
  });

  const { data: contents, isError: contentsError } = useQuery({
    queryKey: ['album-contents', name],
    queryFn: () => workerApiClient.getAlbumContents(name),
    staleTime: 5 * 60 * 1000,
    enabled: name !== '' && data !== undefined,
  });
  const people = contents?.people ?? [];
  const known = contents?.known ?? [];
  const species = contents?.species ?? [];
  const peopleCount = people.length + known.length;
  const requestedTab = params.get('tab');
  const tab =
    (requestedTab === 'people' && peopleCount > 0) || (requestedTab === 'species' && species.length > 0)
      ? requestedTab
      : 'photos';
  const pick = (picked: AlbumFilter) => update({ ...filterPatch(picked), tab: null }, { resetPage: true });
  const chipLabel = !filter
    ? ''
    : filter.kind === 'people'
      ? people.find((p) => p.id === filter.value)
        ? (people.find((p) => p.id === filter.value)?.name ?? 'Unnamed')
        : 'Person'
      : filter.kind === 'known'
        ? (known.find((k) => k.id === filter.value)?.name ?? 'Person')
        : (species.find((s) => s.scientific === filter.value)?.common ?? filter.value);

  // "View all photos of" only for a person the user created (canEdit); never for known or species, nor before contents load.
  const personHref =
    filter?.kind === 'people' && people.find((p) => p.id === filter.value)?.canEdit === true
      ? `/people/${encodeURIComponent(filter.value)}`
      : undefined;

  const { data: summary } = useQuery({
    queryKey: ['album-summary', name],
    queryFn: async () => (await workerApiClient.getAlbumsPage({ limit: 1, name })).albums[0] ?? null,
    enabled: name !== '',
  });
  const coverId = summary?.coverPhotoId;
  // The role comes from the same summary query (GET /albums?name=&limit=1); until it loads, no owner controls show.
  const isOwner = summary?.role === 'owner';
  // With a cover the hero carries the album name and its photo count; the row then counts only filtered results.
  const heroCover = summary?.coverThumbnailUrl;
  const [sharing, setSharing] = useState(false);

  const setCover = useMutation({
    mutationFn: (photoId: string) => workerApiClient.setAlbumCover(name, photoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['album-summary', name] });
      void queryClient.invalidateQueries({ queryKey: ['albums-page'] });
    },
    onError: (e) =>
      notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Could not set cover' }),
  });

  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  return (
    <Stack gap="lg">
      <BackLink to={albumsList}>All albums</BackLink>
      {summary && heroCover && (
        <AlbumHero
          name={name}
          photoCount={summary.photoCount}
          coverPhotoId={summary.coverPhotoId}
          coverThumbnailUrl={heroCover}
          framing={summary.coverFraming}
          canEdit={isOwner}
        />
      )}
      <Group justify="space-between" align={heroCover ? 'center' : 'baseline'}>
        <Group gap="sm" align="center">
          {!heroCover && <Title order={2}>{name}</Title>}
          {isOwner && (summary?.sharedWith?.length ?? 0) > 0 && <AvatarStack emails={summary?.sharedWith ?? []} size="md" />}
          {summary?.role === 'viewer' && (
            <Badge
              variant="light"
              color="grape"
              leftSection={summary.ownerEmail ? <UserAvatar email={summary.ownerEmail} size={18} tooltip={false} /> : undefined}
            >
              {summary.ownerEmail ? `Shared by ${summary.ownerEmail}` : 'Shared with you'}
            </Badge>
          )}
          {isOwner && (
            <Button size="xs" variant="light" onClick={() => setSharing(true)}>
              Share
            </Button>
          )}
        </Group>
        <Group gap="md" align="center">
          {data && (!heroCover || filter) && (
            <Text c="dimmed">
              {data.total} {data.total === 1 ? 'photo' : 'photos'}
            </Text>
          )}
          <SortIcons
            label="Sort photos"
            options={SORT_OPTIONS}
            value={sort}
            onChange={(value) => update({ sort: value === 'date' ? null : value }, { resetPage: true })}
          />
          <ColumnsToggle />
        </Group>
      </Group>
      {contentsError && <Text c="dimmed">Could not load people and species.</Text>}
      <Tabs value={tab} keepMounted={false} onChange={(v) => update({ tab: v === 'photos' ? null : v })}>
        {(peopleCount > 0 || species.length > 0) && (
          <Tabs.List mb="lg">
            <Tabs.Tab value="photos">Photos</Tabs.Tab>
            {peopleCount > 0 && <Tabs.Tab value="people">People ({peopleCount})</Tabs.Tab>}
            {species.length > 0 && <Tabs.Tab value="species">Species ({species.length})</Tabs.Tab>}
          </Tabs.List>
        )}
        <Tabs.Panel value="people">
          <PeopleTiles people={people} known={known} onPick={pick} />
        </Tabs.Panel>
        <Tabs.Panel value="species">
          <SpeciesTiles species={species} onPick={pick} />
        </Tabs.Panel>
        <Tabs.Panel value="photos">
          <Stack gap="lg">
            {filter && (
              <AlbumFilterChip
                label={chipLabel}
                kind={filter.kind}
                href={personHref}
                onClear={() => update(filterPatch(null), { resetPage: true })}
              />
            )}
            {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
            {data && data.results.length === 0 && (
              <Text c="dimmed">{filter ? 'No photos in this album match this filter.' : 'This album has no photos.'}</Text>
            )}
            {data && data.results.length > 0 && (
              <PhotoGrid
                photos={data.results}
                badges={(photo) =>
                  isOwner && photo.id === coverId ? <CoverBadge /> : null
                }
                actions={(photo) =>
                  isOwner && photo.id !== coverId ? (
                    <SetCoverButton
                      label={photoCaption(photo)}
                      loading={setCover.isPending && setCover.variables === photo.id}
                      onClick={() => setCover.mutate(photo.id)}
                    />
                  ) : null
                }
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
        </Tabs.Panel>
      </Tabs>

      {sharing && summary && (
        <ShareAlbumModal album={name} sharedWith={summary.sharedWith ?? []} opened onClose={() => setSharing(false)} />
      )}
    </Stack>
  );
};

export default AlbumPhotos;
