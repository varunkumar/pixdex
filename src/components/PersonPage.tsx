import { Anchor, Badge, Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { errorMessage, SEARCH_KEYS } from '../services/peopleKeys';
import type { SerializedFace } from '../types/api';
import FaceTile from './FaceTile';
import PhotoGrid from './PhotoGrid';

const PAGE = 24;

/** Shown under each photo: flags an automatic match and lets the owner reject it. */
const AutoMatchFooter = ({
  photoId,
  personId,
  onChanged,
}: {
  photoId: string;
  personId: string;
  onChanged: () => void;
}) => {
  const { data: faces = [] } = useQuery({
    queryKey: ['photo-faces', photoId],
    queryFn: () => workerApiClient.getPhotoFaces(photoId),
  });
  const auto = faces.find((f) => f.personId === personId && f.status === 'auto');
  const reject = useMutation({
    mutationFn: (faceId: string) => workerApiClient.rejectFace(faceId, personId),
    onSuccess: onChanged,
  });
  if (!auto) return null;
  return (
    <Group gap="xs">
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
      {reject.error && (
        <Text size="xs" c="red">
          {errorMessage(reject.error, false)}
        </Text>
      )}
    </Group>
  );
};

const PersonPage = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(PAGE);
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

  const { data: photos, error } = useQuery({
    queryKey: ['person-photos', id, limit],
    queryFn: () => workerApiClient.search({ people: [id], limit }),
    enabled: id !== '',
  });

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
      void queryClient.invalidateQueries({ queryKey: ['people-groups'] });
      navigate('/people');
    },
  });
  const rematch = useMutation({
    mutationFn: async () => {
      setProgress('Looking for matches...');
      try {
        const { matched } = await workerApiClient.matchPersonAll(id, (scanned, found) =>
          setProgress(`Looking for matches... scanned ${scanned}, matched ${found}`)
        );
        notifications.show({
          message: matched > 0 ? `Matched ${matched} more photo${matched === 1 ? '' : 's'}` : 'No new matches',
        });
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
            <Stack gap={0}>
              <Title order={2}>{person.name}</Title>
              <Text size="sm" c="dimmed">
                {person.photoCount} {person.photoCount === 1 ? 'photo' : 'photos'}, {person.faceCount}{' '}
                {person.faceCount === 1 ? 'face' : 'faces'}
              </Text>
            </Stack>
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
      {photos && photos.length > 0 && (
        <PhotoGrid
          photos={photos}
          footer={(photo) => <AutoMatchFooter photoId={photo.id} personId={id} onChanged={refresh} />}
        />
      )}
      {photos && photos.length >= limit && (
        <Button variant="light" w="fit-content" onClick={() => setLimit((l) => l + PAGE)}>
          Show more photos
        </Button>
      )}
    </Stack>
  );
};

export default PersonPage;
