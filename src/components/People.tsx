import { Button, Card, Group, Select, SimpleGrid, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { errorMessage, SEARCH_KEYS } from '../services/peopleKeys';
import type { FaceGroup, PersonSummary } from '../types/api';
import FaceTile from './FaceTile';

const GROUP_TILES = 8;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const GroupCard = ({
  group,
  people,
  onDone,
}: {
  group: FaceGroup;
  people: PersonSummary[];
  onDone: (groupKey: string) => void;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const faceIds = group.faces.map((f) => f.id);

  const finish = async (personId: string) => {
    try {
      setProgress('Looking for more matches...');
      const { matched } = await workerApiClient.matchPersonAll(personId, (scanned, found) =>
        setProgress(`Looking for more matches... scanned ${scanned}, matched ${found}`)
      );
      if (matched > 0) {
        notifications.show({ message: `Matched ${plural(matched, 'more photo')}` });
      }
    } catch {
      // The group is already named; a failed follow-up search must not read as a naming failure.
      notifications.show({ message: 'Named, but could not look for more matches' });
    } finally {
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: ['photo-faces'] });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      for (const key of SEARCH_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
      onDone(faceIds[0]);
    }
  };

  const create = useMutation({
    mutationFn: async (newName: string) => {
      const person = await workerApiClient.createPerson(newName, faceIds);
      await finish(person.id);
    },
  });
  const assign = useMutation({
    mutationFn: async (personId: string) => {
      await workerApiClient.assignFaces(personId, faceIds);
      await finish(personId);
    },
  });

  const busy = create.isPending || assign.isPending;
  const error = create.error ?? assign.error;

  return (
    <Card withBorder data-testid="face-group">
      <Stack gap="sm">
        <Group gap="xs">
          {group.faces.slice(0, GROUP_TILES).map((f) => (
            <FaceTile key={f.id} face={f} size={64} />
          ))}
        </Group>
        <Text size="xs" c="dimmed">
          {plural(group.faces.length, 'face')}
        </Text>
        {!open ? (
          <Button size="xs" variant="light" w="fit-content" onClick={() => setOpen(true)}>
            Name this group
          </Button>
        ) : (
          <Stack gap="xs">
            <Group gap="xs" align="flex-end">
              <TextInput
                aria-label="Person name"
                placeholder="New name"
                size="xs"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.currentTarget.value)}
              />
              <Button
                size="xs"
                loading={create.isPending}
                disabled={name.trim() === '' || busy}
                onClick={() => create.mutate(name.trim())}
              >
                Save name
              </Button>
              <Button size="xs" variant="subtle" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </Group>
            {people.length > 0 && (
              <Select
                aria-label="Existing person"
                placeholder="Or add to an existing person"
                size="xs"
                searchable
                data={people.map((p) => ({ value: p.id, label: p.name }))}
                value={null}
                disabled={busy}
                onChange={(value) => value && assign.mutate(value)}
              />
            )}
          </Stack>
        )}
        {progress && (
          <Text size="xs" c="dimmed" role="status">
            {progress}
          </Text>
        )}
        {error && (
          <Text size="xs" c="red">
            {errorMessage(error, create.error != null)}
          </Text>
        )}
      </Stack>
    </Card>
  );
};

const People = () => {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const { data: people = [], isSuccess: peopleLoaded } = useQuery({
    queryKey: ['people'],
    queryFn: () => workerApiClient.getPeople(),
  });
  const groupsQuery = useInfiniteQuery({
    queryKey: ['people-groups'],
    queryFn: ({ pageParam }) => workerApiClient.getFaceGroups(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const groups = (groupsQuery.data?.pages.flatMap((p) => p.groups) ?? []).filter(
    (g) => g.faces.length > 0 && !hidden.has(g.faces[0].id)
  );
  const loaded = peopleLoaded && groupsQuery.isSuccess;

  return (
    <Stack gap="lg">
      <Title order={2}>People</Title>
      {(groupsQuery.error != null) && <Text c="red">Could not load unnamed faces</Text>}

      {loaded && people.length === 0 && groups.length === 0 && (
        <Text c="dimmed">No faces yet. Index some photos and faces will appear here to name.</Text>
      )}

      {people.length > 0 && (
        <SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }} spacing="md">
          {people.map((p) => (
            <UnstyledButton key={p.id} component={Link} to={`/people/${p.id}`}>
              <Card withBorder padding="sm">
                <Stack gap={4} align="center">
                  {p.cover ? (
                    <FaceTile face={{ ...p.cover, personName: null }} size={96} />
                  ) : (
                    <Text c="dimmed" h={96} lh="96px">
                      No cover
                    </Text>
                  )}
                  <Text fw={600} ta="center">
                    {p.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {plural(p.photoCount, 'photo')}, {plural(p.faceCount, 'face')}
                  </Text>
                </Stack>
              </Card>
            </UnstyledButton>
          ))}
        </SimpleGrid>
      )}

      {groups.length > 0 && (
        <Stack gap="md">
          <Title order={3}>Unnamed groups</Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {groups.map((g) => (
              <GroupCard
                key={g.faces[0].id}
                group={g}
                people={people}
                onDone={(key) => setHidden((prev) => new Set(prev).add(key))}
              />
            ))}
          </SimpleGrid>
        </Stack>
      )}

      {groupsQuery.hasNextPage && (
        <Button
          variant="light"
          w="fit-content"
          loading={groupsQuery.isFetchingNextPage}
          onClick={() => void groupsQuery.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </Stack>
  );
};

export default People;
