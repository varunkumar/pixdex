import { Badge, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { matchQueueFor, refreshAfterIgnoring, refreshAfterNaming, refreshAfterRestoring } from '../services/matchQueue';
import { errorMessage, SEARCH_KEYS, UNNAMED_PERSON } from '../services/peopleKeys';
import type { PersonSummary, SerializedFace } from '../types/api';
import FaceTile from './FaceTile';
import PersonLabelEditor from './PersonLabelEditor';

const STATUS_LABEL: Record<SerializedFace['status'], string> = {
  auto: 'Auto-matched',
  confirmed: 'Confirmed',
  unassigned: 'Unnamed',
};

const FaceRow = ({
  face,
  index,
  people,
  canManage,
  onNamed,
  onChanged,
}: {
  face: SerializedFace;
  index: number;
  people: PersonSummary[];
  canManage: boolean;
  onNamed: (personId: string, faceId: string) => void;
  onChanged: () => void;
}) => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  const assign = useMutation({
    mutationFn: async (personId: string) => {
      await workerApiClient.assignFace(face.id, personId);
      onNamed(personId, face.id);
    },
  });
  const create = useMutation({
    mutationFn: async (newName: string) => {
      const person = await workerApiClient.createPerson(newName, [face.id]);
      onNamed(person.id, face.id);
    },
    onSuccess: () => {
      setCreating(false);
      setName('');
    },
  });
  const reject = useMutation({
    mutationFn: (personId: string) => workerApiClient.rejectFace(face.id, personId),
    onSuccess: onChanged,
  });
  const unassign = useMutation({
    mutationFn: () => workerApiClient.unassignFace(face.id),
    onSuccess: onChanged,
  });

  const setCover = useMutation({
    mutationFn: (personId: string) => workerApiClient.setPersonCover(personId, face.id),
    onSuccess: onChanged,
  });

  const ignore = useMutation({
    mutationFn: () => workerApiClient.ignoreFaces([face.id]),
    onSuccess: () => refreshAfterIgnoring(queryClient, [face.id]),
  });
  const restore = useMutation({
    mutationFn: () => workerApiClient.restoreFaces([face.id]),
    onSuccess: () => refreshAfterRestoring(queryClient),
  });

  const naming = (assign.error ?? create.error) != null;
  const error =
    assign.error ?? create.error ?? reject.error ?? unassign.error ?? setCover.error ?? ignore.error ?? restore.error;
  const named = face.personId != null && face.status !== 'unassigned';
  const busy =
    assign.isPending || create.isPending || reject.isPending || unassign.isPending || setCover.isPending || ignore.isPending || restore.isPending;
  // Only the album owner sees (and can undo) that a face is ignored.
  const ignored = canManage && face.ignored === true;
  const isCover = named && people.find((p) => p.id === face.personId)?.cover?.id === face.id;

  return (
    <Group data-testid="face-row" align="flex-start" wrap="nowrap" gap="md">
      <Stack gap={2} align="center">
        <Badge size="sm" circle>
          {index + 1}
        </Badge>
        <FaceTile face={face} index={index} />
      </Stack>
      <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {ignored ? 'Ignored' : STATUS_LABEL[face.status]}
        </Text>

        {!canManage ? (
          named ? (
            <>
              <Text size="sm" c={face.personName === null ? 'dimmed' : undefined}>
                {face.personName ?? UNNAMED_PERSON}
              </Text>
              {/* A person on a photo the caller does not own is never the caller's: they may only label it. */}
              <PersonLabelEditor personId={face.personId as string} name={face.personName} />
            </>
          ) : null
        ) : ignored ? (
          <Button size="xs" variant="light" w="fit-content" disabled={busy} onClick={() => restore.mutate()}>
            Restore
          </Button>
        ) : named ? (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              color="red"
              disabled={busy}
              onClick={() => reject.mutate(face.personId as string)}
            >
              Not {face.personName}
            </Button>
            {isCover ? (
              <Badge size="sm" variant="light" color="teal">
                Cover
              </Badge>
            ) : (
              <Button
                size="xs"
                variant="light"
                disabled={busy}
                onClick={() => setCover.mutate(face.personId as string)}
              >
                Set as cover
              </Button>
            )}
            {/* Soft: an auto face is already corrected with "Not X"; Remove name is for confirmed faces. */}
            {face.status === 'confirmed' && (
              <Button size="xs" variant="subtle" disabled={busy} onClick={() => unassign.mutate()}>
                Remove name
              </Button>
            )}
          </Group>
        ) : creating ? (
          <Group gap="xs" align="flex-end">
            <TextInput
              aria-label="Person name"
              placeholder="Name"
              size="xs"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Button
              size="xs"
              loading={create.isPending}
              disabled={name.trim() === ''}
              onClick={() => create.mutate(name.trim())}
            >
              Save name
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </Group>
        ) : (
          <Group gap="xs" align="flex-end">
            <Select
              aria-label="Existing person"
              placeholder="Choose a person"
              size="xs"
              searchable
              data={people.map((p) => ({ value: p.id, label: p.name ?? UNNAMED_PERSON }))}
              value={null}
              disabled={busy}
              onChange={(value) => value && assign.mutate(value)}
            />
            <Button size="xs" variant="light" onClick={() => setCreating(true)}>
              New person
            </Button>
            <Button size="xs" variant="subtle" color="gray" disabled={busy} onClick={() => ignore.mutate()}>
              Ignore
            </Button>
          </Group>
        )}

        {error && (
          <Text size="xs" c="red">
            {errorMessage(error, naming)}
          </Text>
        )}
      </Stack>
    </Group>
  );
};

/** People found in a photo, with controls to name them and correct automatic matches. */
const PhotoFaces = ({ photoId, canEdit }: { photoId: string; canEdit: boolean }) => {
  const queryClient = useQueryClient();
  const { data: faces = [] } = useQuery({
    queryKey: ['photo-faces', photoId],
    queryFn: () => workerApiClient.getPhotoFaces(photoId),
  });
  // The people list only feeds the naming controls, which only the album owner sees.
  const { data: people = [] } = useQuery({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
    enabled: canEdit,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['photo-faces', photoId] });
    void queryClient.invalidateQueries({ queryKey: ['people'] });
    for (const key of SEARCH_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  };

  // After naming a face, look for the person's other unnamed faces in the background.
  const onNamed = (personId: string, faceId: string) => {
    refreshAfterNaming(queryClient, [faceId]);
    matchQueueFor(queryClient).enqueue(personId);
  };

  if (faces.length === 0) return null;

  return (
    <Card withBorder data-testid="photo-faces">
      <Stack gap="md">
        <Title order={5}>People</Title>
        <Stack gap="md">
          {faces.map((f, i) => (
            <FaceRow
              key={f.id}
              face={f}
              index={i}
              people={people.filter((p) => p.canEdit)}
              canManage={canEdit}
              onNamed={onNamed}
              onChanged={refresh}
            />
          ))}
        </Stack>
      </Stack>
    </Card>
  );
};

export default PhotoFaces;
