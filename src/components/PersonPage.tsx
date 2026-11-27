import { ActionIcon, Anchor, Button, Group, Menu, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { IconType } from 'react-icons';
import { TbCalendar, TbDotsVertical, TbSparkles, TbStar } from 'react-icons/tb';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useListParams } from '../hooks/useListParams';
import { useMatchQueue } from '../hooks/useMatchQueue';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import { noteRemovedName } from '../services/matchQueue';
import { photoCaption } from '../services/text';
import { errorMessage, SEARCH_KEYS, UNNAMED_PERSON } from '../services/peopleKeys';
import type { SerializedFace } from '../types/api';
import ColumnsToggle from './ColumnsToggle';
import FaceTile from './FaceTile';
import ListPagination from './ListPagination';
import PersonLabelEditor from './PersonLabelEditor';
import PhotoGrid from './PhotoGrid';
import SortIcons from './SortIcons';

const PHOTO_PAGE_SIZES = [12, 24, 48] as const;

const SORT_OPTIONS: { value: PhotoSort; label: string; icon?: IconType; text?: string }[] = [
  { value: 'date', label: 'Newest first', icon: TbCalendar },
  { value: 'rating', label: 'Best rated', icon: TbStar },
  { value: 'name', label: 'Alphabetical', text: 'A-Z' },
];

/** This person's faces in one photo: the automatic match, and the largest face to offer as the cover. */
const usePersonFaces = (photoId: string, personId: string, coverFaceId: string | undefined) => {
  const { data: faces = [] } = useQuery({
    queryKey: ['photo-faces', photoId],
    queryFn: () => workerApiClient.getPhotoFaces(photoId),
  });
  const mine = faces.filter((f) => f.personId === personId && f.status !== 'unassigned');
  const auto = mine.find((f) => f.status === 'auto');
  // Offer the largest of this person's faces in the photo as the cover candidate.
  const candidate = [...mine].sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];
  const isCover = coverFaceId != null && mine.some((f) => f.id === coverFaceId);
  return { auto, candidate, isCover };
};

/** A small sparkle before the title of a photo whose face match for this person was automatic (not a loud badge). */
const PersonFaceBadge = ({ photoId, personId }: { photoId: string; personId: string }) => {
  const { auto } = usePersonFaces(photoId, personId, undefined);
  return auto ? (
    <Tooltip label="Matched automatically">
      <span className="pdx-tile-mark" role="img" aria-label="Matched automatically">
        <TbSparkles size={13} aria-hidden />
      </span>
    </Tooltip>
  ) : null;
};

/** Per photo: a menu to set the person's cover or reject an automatic match. */
const PersonFaceActions = ({
  photoId,
  personId,
  coverFaceId,
  label,
  onChanged,
}: {
  photoId: string;
  personId: string;
  coverFaceId: string | undefined;
  /** The photo's caption, so each menu button has its own accessible name. */
  label: string;
  onChanged: () => void;
}) => {
  const { auto, candidate, isCover } = usePersonFaces(photoId, personId, coverFaceId);
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
  const setCover = useMutation({
    mutationFn: (faceId: string) => workerApiClient.setPersonCover(personId, faceId),
    onSuccess: onChanged,
    onError,
  });
  if (!candidate) return null;
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="filled"
          color="dark"
          size="md"
          aria-label={`Photo actions for ${label}`}
          loading={reject.isPending || setCover.isPending}
        >
          <TbDotsVertical aria-hidden />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {isCover ? (
          <Menu.Item disabled>Current cover</Menu.Item>
        ) : (
          <Menu.Item onClick={() => setCover.mutate(candidate.id)}>Set as cover</Menu.Item>
        )}
        {auto && (
          <Menu.Item color="red" onClick={() => reject.mutate(auto.id)}>
            Not {auto.personName}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
};

const PersonPage = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { params, page, size, offset, update } = useListParams(24, PHOTO_PAGE_SIZES);
  const requestedSort = params.get('sort');
  const sort = SORT_OPTIONS.find((o) => o.value === requestedSort)?.value ?? 'date';
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [suggestions, setSuggestions] = useState<SerializedFace[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

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
  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    [update]

  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['photo-faces'] });
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
      setSuggestions((prev) => (from ? [...(prev ?? []), ...res.suggestions] : res.suggestions));
      setCursor(res.nextCursor);
    },
  });
  const drop = (faceId: string) => setSuggestions((prev) => (prev ?? []).filter((f) => f.id !== faceId));
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
      <Anchor component={Link} to="/people" size="sm">
        ← All people
      </Anchor>
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
            <Group gap="xs">
              <Text size="sm">Delete {person.name ?? UNNAMED_PERSON}? Their faces become unnamed again.</Text>
              <Button size="xs" color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
                Confirm delete
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </Group>
          )}

          {person?.canEdit && (
            <Group gap="xs">
              <Button size="xs" loading={review.isPending && !cursor} onClick={() => review.mutate(null)}>
                Review suggestions
              </Button>
              <Button size="xs" variant="light" loading={matching} onClick={() => enqueue(id, { manual: true })}>
                Re-run matching
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
      {photos && photos.length > 0 && (
        <PhotoGrid
          photos={photos}
          showAlbum
          mark={(photo) => (person?.canEdit ? <PersonFaceBadge photoId={photo.id} personId={id} /> : null)}
          actions={(photo) =>
            person?.canEdit ? (
              <PersonFaceActions
                photoId={photo.id}
                personId={id}
                coverFaceId={person?.cover?.id}
                label={photoCaption(photo)}
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
