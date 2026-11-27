import { ActionIcon, Button, Group, Menu, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { IconType } from 'react-icons';
import { TbCalendar, TbDotsVertical, TbSparkles, TbStar } from 'react-icons/tb';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useHistoryState } from '../hooks/useHistoryState';
import { useLastAddress, useRememberAddress } from '../hooks/useLastAddress';
import { useListParams } from '../hooks/useListParams';
import { useMatchQueue } from '../hooks/useMatchQueue';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import { markReviewQueueStale, noteRemovedName } from '../services/matchQueue';
import { photoCaption } from '../services/text';
import { errorMessage, SEARCH_KEYS, UNNAMED_PERSON } from '../services/peopleKeys';
import type { SerializedFace } from '../types/api';
import BackLink from './BackLink';
import ColumnsToggle from './ColumnsToggle';
import CoverBadge from './CoverBadge';
import FaceTile from './FaceTile';
import InlineConfirm from './InlineConfirm';
import ListPagination from './ListPagination';
import PageLoading from './PageLoading';
import PersonLabelEditor from './PersonLabelEditor';
import PhotoGrid from './PhotoGrid';
import SetCoverButton from './SetCoverButton';
import SortIcons from './SortIcons';

const PHOTO_PAGE_SIZES = [12, 24, 48] as const;

const SORT_OPTIONS: { value: PhotoSort; label: string; icon?: IconType; text?: string }[] = [
  { value: 'date', label: 'Newest first', icon: TbCalendar },
  { value: 'rating', label: 'Best rated', icon: TbStar },
  { value: 'name', label: 'Alphabetical', text: 'A-Z' },
];

/** This person's automatic match in one photo, and their largest face there (the cover candidate). */
const facesOn = (faces: SerializedFace[], photoId: string, personId: string) => {
  const mine = faces.filter((f) => f.photoId === photoId && f.personId === personId && f.status !== 'unassigned');
  const auto = mine.find((f) => f.status === 'auto');
  const candidate = [...mine].sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];
  return { auto, candidate };
};

/** A small sparkle before the title of a photo whose face match for this person was automatic (not a loud badge). */
const AutoMark = () => (
  <Tooltip label="Matched automatically">
    <span className="pdx-tile-mark" role="img" aria-label="Matched automatically">
      <TbSparkles size={13} aria-hidden />
    </span>
  </Tooltip>
);

/** Per photo: set the person's cover, and for an automatic match a menu to confirm or reject it. */
const PersonFaceActions = ({
  personId,
  auto,
  candidate,
  isCover,
  label,
  canConfirm,
  onChanged,
}: {
  personId: string;
  auto: SerializedFace | undefined;
  candidate: SerializedFace | undefined;
  isCover: boolean;
  /** The photo's caption, so each button has its own accessible name. */
  label: string;
  /** The caller owns the photo's album, which confirming requires. */
  canConfirm: boolean;
  onChanged: () => void;
}) => {
  // The menu closes on click, so a failure is reported as a notification, not inside the dropdown.
  const onError = (error: unknown) => notifications.show({ color: 'red', message: errorMessage(error, false) });
  const queryClient = useQueryClient();
  const reject = useMutation({
    mutationFn: (faceId: string) => workerApiClient.rejectFace(faceId, personId),
    onSuccess: (_r, faceId) => {
      noteRemovedName(queryClient, faceId, personId);
      onChanged();
    },
    onError,
  });
  const confirm = useMutation({
    mutationFn: (faceId: string) => workerApiClient.reviewAutoFaces(personId, { confirm: [faceId], reject: [] }),
    onSuccess: ({ confirmed }) => {
      if (confirmed.length === 0) notifications.show({ message: 'This face had changed, nothing was confirmed' });
      onChanged();
    },
    onError,
  });
  const setCover = useMutation({
    mutationFn: (faceId: string) => workerApiClient.setPersonCover(personId, faceId),
    onSuccess: onChanged,
    onError,
  });
  if (!candidate) return null;
  return (
    <>
      {!isCover && (
        <SetCoverButton label={label} loading={setCover.isPending} onClick={() => setCover.mutate(candidate.id)} />
      )}
      {auto && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="filled"
              color="dark"
              size="md"
              aria-label={`Photo actions for ${label}`}
              loading={reject.isPending || confirm.isPending}
            >
              <TbDotsVertical aria-hidden />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {canConfirm && <Menu.Item onClick={() => confirm.mutate(auto.id)}>Confirm {auto.personName}</Menu.Item>}
            <Menu.Item color="red" onClick={() => reject.mutate(auto.id)}>
              Not {auto.personName}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
    </>
  );
};

interface Found {
  /** Null until "Review suggestions" has answered. */
  suggestions: SerializedFace[] | null;
  cursor: string | null;
}
const NOTHING_FOUND: Found = { suggestions: null, cursor: null };

const PersonPage = () => {
  useRememberAddress();
  const peopleList = useLastAddress('/people');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { params, page, size, offset, update } = useListParams(24, PHOTO_PAGE_SIZES);
  const requestedSort = params.get('sort');
  const sort = SORT_OPTIONS.find((o) => o.value === requestedSort)?.value ?? 'date';
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Kept with the history entry: opening a suggestion's photo and going back must not lose the list.
  const [{ suggestions, cursor }, setFound] = useHistoryState<Found>(`suggestions:${id}`, NOTHING_FOUND);

  const { data: people = [], isSuccess: peopleLoaded } = useQuery({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
  });
  const person = people.find((p) => p.id === id);

  const {
    data: photoPage,
    error,
    isPlaceholderData,
  } = useQuery({
    queryKey: ['person-photos', id, size, offset, sort],
    queryFn: () => workerApiClient.searchPage({ people: [id], sort, limit: size, offset }),
    enabled: id !== '',
    placeholderData: keepPreviousData,
  });
  const photos = photoPage?.results;
  // One request for the whole page of photos. No placeholder: another page's faces must not drive these controls.
  const photoIds = photos?.map((p) => p.id) ?? [];
  const faces = useQuery({
    queryKey: ['person-faces', id, photoIds],
    queryFn: () => workerApiClient.getPersonFaces(id, photoIds),
    enabled: person?.canEdit === true && photoIds.length > 0,
  });
  const on = (photoId: string) => facesOn(faces.data ?? [], photoId, id);
  const isCover = (photoId: string) => person?.cover?.photoId === photoId;
  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    [update]

  );

  const refresh = () => {
    markReviewQueueStale(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['photo-faces'] });
    void queryClient.invalidateQueries({ queryKey: ['person-faces'] });
    void queryClient.invalidateQueries({ queryKey: ['people'] });
    for (const key of SEARCH_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  };

  const rename = useMutation({
    mutationFn: (name: string) => workerApiClient.renamePerson(id, name),
    onSuccess: () => {
      setRenaming(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => workerApiClient.deletePerson(id),
    onSuccess: () => {
      refresh();
      navigate('/people');
    },
  });
  const { current, waiting, enqueue } = useMatchQueue();
  const matching = current?.personId === id || waiting.includes(id);
  const review = useMutation({
    mutationFn: (from: string | null) =>
      from ? workerApiClient.matchPerson(id, { cursor: from }) : workerApiClient.matchPerson(id),
    onSuccess: (res, from) => {
      setFound((prev) => ({
        suggestions: from ? [...(prev.suggestions ?? []), ...res.suggestions] : res.suggestions,
        cursor: res.nextCursor,
      }));
    },
  });
  const drop = (faceId: string) =>
    setFound((prev) => ({ ...prev, suggestions: (prev.suggestions ?? []).filter((f) => f.id !== faceId) }));
  const accept = useMutation({
    mutationFn: (faceId: string) => workerApiClient.assignFace(faceId, id),
    onSuccess: (_r, faceId) => {
      drop(faceId);
      refresh();
    },
  });
  const decline = useMutation({
    mutationFn: (faceId: string) => workerApiClient.rejectFace(faceId, id),
    onSuccess: (_r, faceId) => drop(faceId),
  });

  const actionError = rename.error ?? remove.error ?? review.error ?? accept.error ?? decline.error;

  return (
    <Stack gap="lg">
      <BackLink to={peopleList}>All people</BackLink>
      {peopleLoaded && !person && <Text c="dimmed">This person was not found.</Text>}
      {person && (
        <>
          <Group justify="space-between" align="center">
            <Group gap="md" wrap="nowrap">
              {person.cover && <FaceTile face={{ ...person.cover, personName: null }} size={72} />}
              <Stack gap={0}>
                <Title order={2} c={person.name === null ? 'dimmed' : undefined}>
                  {person.name ?? UNNAMED_PERSON}
                </Title>
                <Text size="sm" c="dimmed">
                  {person.photoCount} {person.photoCount === 1 ? 'photo' : 'photos'}, {person.faceCount}{' '}
                  {person.faceCount === 1 ? 'face' : 'faces'}
                </Text>
                {!person.canEdit && <PersonLabelEditor personId={person.id} name={person.name} />}
              </Stack>
            </Group>
            {person?.canEdit && (
              <Group gap="xs">
                <Button
                  variant="light"
                  size="xs"
                  onClick={() => {
                    setNewName(person.name ?? '');
                    setRenaming(true);
                  }}
                >
                  Rename
                </Button>
                <Button variant="light" color="red" size="xs" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </Button>
              </Group>
            )}
          </Group>

          {renaming && (
            <Group gap="xs" align="flex-end">
              <TextInput
                aria-label="Person name"
                size="xs"
                value={newName}
                onChange={(e) => setNewName(e.currentTarget.value)}
              />
              <Button
                size="xs"
                loading={rename.isPending}
                disabled={newName.trim() === ''}
                onClick={() => rename.mutate(newName.trim())}
              >
                Save name
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </Group>
          )}

          {confirmingDelete && (
            <InlineConfirm
              message={`Delete ${person.name ?? UNNAMED_PERSON}? Their faces become unnamed again.`}
              confirmLabel="Confirm delete"
              loading={remove.isPending}
              onConfirm={() => remove.mutate()}
              onCancel={() => setConfirmingDelete(false)}
            />
          )}

          {person?.canEdit && (
            <Group gap="xs">
              <Button size="xs" loading={review.isPending && !cursor} onClick={() => review.mutate(null)}>
                Review suggestions
              </Button>
              <Button size="xs" variant="light" loading={matching} onClick={() => enqueue(id, { manual: true })}>
                Re-run matching
              </Button>
              <Button size="xs" variant="light" component={Link} to={`/people/${id}/review`}>
                Review auto matches
              </Button>
            </Group>
          )}
          {actionError && (
            <Text size="sm" c="red">
              {errorMessage(actionError, rename.error != null)}
            </Text>
          )}

          {suggestions && (
            <Stack gap="sm">
              <Title order={4}>Suggestions</Title>
              {suggestions.length === 0 && <Text c="dimmed">No suggestions right now.</Text>}
              <Group gap="md" align="flex-start">
                {suggestions.map((f) => (
                  <Stack key={f.id} gap={4} align="center" data-testid="suggestion">
                    <Link to={`/photos/${f.photoId}`} aria-label="Open photo">
                      <FaceTile face={f} size={88} />
                    </Link>
                    <Group gap={4}>
                      <Button size="compact-xs" onClick={() => accept.mutate(f.id)}>
                        Yes
                      </Button>
                      <Button size="compact-xs" variant="light" color="red" onClick={() => decline.mutate(f.id)}>
                        Not them
                      </Button>
                    </Group>
                  </Stack>
                ))}
              </Group>
              {cursor && (
                <Button
                  size="xs"
                  variant="light"
                  w="fit-content"
                  loading={review.isPending}
                  onClick={() => review.mutate(cursor)}
                >
                  Check more
                </Button>
              )}
            </Stack>
          )}
        </>
      )}

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
      {!photos && !error && <PageLoading label="Loading photos" />}
      {photos && photos.length === 0 && <Text c="dimmed">No photos for this person yet.</Text>}
      {person && (
        <Group gap="xs" justify="flex-end">
          <SortIcons
            label="Sort photos"
            options={SORT_OPTIONS}
            value={sort}
            onChange={(value) => update({ sort: value === 'date' ? null : value }, { resetPage: true })}
          />
          <ColumnsToggle />
        </Group>
      )}
      {faces.isError && (
        <Group gap="xs">
          <Text size="sm" c="red">
            Could not load photo actions
          </Text>
          <Button size="xs" variant="light" onClick={() => void faces.refetch()}>
            Try again
          </Button>
        </Group>
      )}
      {photos && photos.length > 0 && (
        <PhotoGrid
          photos={photos}
          showAlbum
          badges={(photo) => (person?.canEdit && isCover(photo.id) ? <CoverBadge /> : null)}
          mark={(photo) => (person?.canEdit && on(photo.id).auto ? <AutoMark /> : null)}
          actions={(photo) =>
            person?.canEdit ? (
              <PersonFaceActions
                personId={id}
                {...on(photo.id)}
                isCover={isCover(photo.id)}
                label={photoCaption(photo)}
                canConfirm={photo.canEdit}
                onChanged={refresh}
              />
            ) : null
          }
        />
      )}
      {photoPage && (
        <ListPagination
          page={page}
          size={size}
          total={photoPage.total}
          settled={!isPlaceholderData}
          sizes={PHOTO_PAGE_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default PersonPage;
