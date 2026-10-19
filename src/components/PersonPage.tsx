import { Anchor, Badge, Button, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient, type PhotoSort } from '../services/api/WorkerApiClient';
import { errorMessage, matchedMessage, SEARCH_KEYS, TRUNCATED_MESSAGE } from '../services/peopleKeys';
import type { SerializedFace } from '../types/api';
import FaceTile from './FaceTile';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';

const PHOTO_PAGE_SIZES = [12, 24, 48] as const;

const SORT_OPTIONS: { value: PhotoSort; label: string }[] = [
  { value: 'date', label: 'Newest first' },
  { value: 'rating', label: 'Best rated' },
  { value: 'name', label: 'Alphabetical' },
];

/** Shown under each photo: the person's cover control, plus a flag on an automatic match with a way to reject it. */
const PersonFaceFooter = ({
  photoId,
  personId,
  coverFaceId,
  onChanged,
}: {
  photoId: string;
  personId: string;
  coverFaceId: string | undefined;
  onChanged: () => void;
}) => {
  const { data: faces = [] } = useQuery({
    queryKey: ['photo-faces', photoId],
    queryFn: () => workerApiClient.getPhotoFaces(photoId),
  });
  const mine = faces.filter((f) => f.personId === personId && f.status !== 'unassigned');
  const auto = mine.find((f) => f.status === 'auto');
  // Offer the largest of this person's faces in the photo as the cover candidate.
  const candidate = [...mine].sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];
  const isCover = coverFaceId != null && mine.some((f) => f.id === coverFaceId);
  const reject = useMutation({
    mutationFn: (faceId: string) => workerApiClient.rejectFace(faceId, personId),
    onSuccess: onChanged,
  });
  const setCover = useMutation({
    mutationFn: (faceId: string) => workerApiClient.setPersonCover(personId, faceId),
    onSuccess: onChanged,
  });
  if (!candidate) return null;
  return (
    <Group gap="xs">
      {auto && (
        <>
          <Badge size="sm" variant="light" color="grape">
            Auto
          </Badge>
          <Button
            size="xs"
            variant="light"
            color="red"
            loading={reject.isPending}
            onClick={() => reject.mutate(auto.id)}
          >
            Not {auto.personName}
          </Button>
        </>
      )}
      {isCover ? (
        <Badge size="sm" variant="light" color="teal">
          Cover
        </Badge>
      ) : (
        <Button size="xs" variant="light" loading={setCover.isPending} onClick={() => setCover.mutate(candidate.id)}>
          Set as cover
        </Button>
      )}
      {(reject.error ?? setCover.error) && (
        <Text size="xs" c="red">
          {errorMessage(reject.error ?? setCover.error, false)}
        </Text>
      )}
    </Group>
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
  const [progress, setProgress] = useState<string | null>(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, size]
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
  const rematch = useMutation({
    mutationFn: async () => {
      setProgress('Looking for matches...');
      try {
        const { matched, truncated } = await workerApiClient.matchPersonAll(id, (scanned, found) =>
          setProgress(`Looking for matches... scanned ${scanned}, matched ${found}`)
        );
        notifications.show({ message: matched > 0 ? matchedMessage(matched) : 'No new matches' });
        if (truncated) notifications.show({ message: TRUNCATED_MESSAGE });
      } finally {
        setProgress(null);
        refresh();
      }
    },
  });
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

  const actionError = rename.error ?? remove.error ?? rematch.error ?? review.error ?? accept.error ?? decline.error;

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
                <Title order={2}>{person.name}</Title>
                <Text size="sm" c="dimmed">
                  {person.photoCount} {person.photoCount === 1 ? 'photo' : 'photos'}, {person.faceCount}{' '}
                  {person.faceCount === 1 ? 'face' : 'faces'}
                </Text>
              </Stack>
            </Group>
            <Group gap="xs">
              <Button
                variant="light"
                size="xs"
                onClick={() => {
                  setNewName(person.name);
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
              <Button variant="light" color="red" size="xs" onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            </Group>
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
              <Text size="sm">Delete {person.name}? Their faces become unnamed again.</Text>
              <Button size="xs" color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
                Confirm delete
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </Group>
          )}

          <Group gap="xs">
            <Button size="xs" loading={review.isPending && !cursor} onClick={() => review.mutate(null)}>
              Review suggestions
            </Button>
            <Button size="xs" variant="light" loading={rematch.isPending} onClick={() => rematch.mutate()}>
              Re-run matching
            </Button>
          </Group>
          {progress && (
            <Text size="sm" c="dimmed" role="status">
              {progress}
            </Text>
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
        <Select
          aria-label="Sort photos"
          data={SORT_OPTIONS}
          value={sort}
          allowDeselect={false}
          w={170}
          onChange={(value) => update({ sort: value === 'date' ? null : value }, { resetPage: true })}
        />
      )}
      {photos && photos.length > 0 && (
        <PhotoGrid
          photos={photos}
          footer={(photo) => (
            <PersonFaceFooter photoId={photo.id} personId={id} coverFaceId={person?.cover?.id} onChanged={refresh} />
          )}
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
