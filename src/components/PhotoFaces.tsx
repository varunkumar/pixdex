import { Badge, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { errorMessage, matchedMessage, SEARCH_KEYS, TRUNCATED_MESSAGE } from '../services/peopleKeys';
import type { PersonSummary, SerializedFace } from '../types/api';
import FaceTile from './FaceTile';

const STATUS_LABEL: Record<SerializedFace['status'], string> = {
  auto: 'Auto-matched',
  confirmed: 'Confirmed',
  unassigned: 'Unnamed',
};

const FaceRow = ({
  face,
  index,
  people,
  onNamed,
  onChanged,
}: {
  face: SerializedFace;
  index: number;
  people: PersonSummary[];
  onNamed: (personId: string) => Promise<void>;
  onChanged: () => void;
}) => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const assign = useMutation({
    mutationFn: async (personId: string) => {
      await workerApiClient.assignFace(face.id, personId);
      await onNamed(personId);
    },
  });
  const create = useMutation({
    mutationFn: async (newName: string) => {
      const person = await workerApiClient.createPerson(newName, [face.id]);
      await onNamed(person.id);
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

  const naming = (assign.error ?? create.error) != null;
  const error = assign.error ?? create.error ?? reject.error ?? unassign.error ?? setCover.error;
  const named = face.personId != null && face.status !== 'unassigned';
  const busy = assign.isPending || create.isPending || reject.isPending || unassign.isPending || setCover.isPending;
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
          {STATUS_LABEL[face.status]}
        </Text>

        {named ? (
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
              data={people.map((p) => ({ value: p.id, label: p.name }))}
              value={null}
              disabled={busy}
              onChange={(value) => value && assign.mutate(value)}
            />
            <Button size="xs" variant="light" onClick={() => setCreating(true)}>
              New person
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
const PhotoFaces = ({ photoId }: { photoId: string }) => {
  const queryClient = useQueryClient();
  const { data: faces = [] } = useQuery({
    queryKey: ['photo-faces', photoId],
    queryFn: () => workerApiClient.getPhotoFaces(photoId),
  });
  const { data: people = [] } = useQuery({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['photo-faces', photoId] });
    void queryClient.invalidateQueries({ queryKey: ['people'] });
    for (const key of SEARCH_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  };

  // After naming a face, attach the person's other unnamed faces automatically.
  const onNamed = async (personId: string) => {
    try {
      const { matched, truncated } = await workerApiClient.matchPersonAll(personId);
      if (matched > 0) notifications.show({ message: matchedMessage(matched) });
      if (truncated) notifications.show({ message: TRUNCATED_MESSAGE });
    } catch {
      // The face is already named; a failed follow-up search must not read as a naming failure.
      notifications.show({ message: 'Named, but could not look for more matches' });
    } finally {
      refresh();
    }
  };

  if (faces.length === 0) return null;

  return (
    <Card withBorder data-testid="photo-faces">
      <Stack gap="md">
        <Title order={5}>People</Title>
        <Stack gap="md">
          {faces.map((f, i) => (
            <FaceRow key={f.id} face={f} index={i} people={people} onNamed={onNamed} onChanged={refresh} />
          ))}
        </Stack>
      </Stack>
    </Card>
  );
};

export default PhotoFaces;
