import { Button, Card, Group, Select, SimpleGrid, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { errorMessage, matchedMessage, SEARCH_KEYS, TRUNCATED_MESSAGE } from '../services/peopleKeys';
import type { FaceGroup, PersonSummary } from '../types/api';
import FaceTile from './FaceTile';
import ListPagination from './ListPagination';

const GROUP_TILES = 8;

const SORT_OPTIONS = [
  { value: 'name', label: 'Alphabetical' },
  { value: 'count', label: 'Most faces' },
];

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
      const { matched, truncated } = await workerApiClient.matchPersonAll(personId, (scanned, found) =>
        setProgress(`Looking for more matches... scanned ${scanned}, matched ${found}`)
      );
      if (matched > 0) notifications.show({ message: matchedMessage(matched) });
      if (truncated) notifications.show({ message: TRUNCATED_MESSAGE });
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
          {[...group.faces]
            .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)
            .slice(0, GROUP_TILES)
            .map((f) => (
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

const PEOPLE_PAGE_SIZES = [12, 24, 48] as const;
const GROUP_PAGE_SIZES = [6, 12, 24] as const;

const People = () => {
  const { params, page, size, offset, update } = useListParams(12, PEOPLE_PAGE_SIZES);
  const sort = SORT_OPTIONS.find((o) => o.value === params.get('sort'))?.value ?? 'name';
  const [groupPage, setGroupPage] = useState(1);
  const [groupSize, setGroupSize] = useState<number>(GROUP_PAGE_SIZES[0]);
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
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = groupsQuery;

  // Groups come from the Worker a cursor page at a time: load more until the current page is full.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && groups.length < groupPage * groupSize) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, groups.length, groupPage, groupSize]);

  const onPeoplePage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, size]
  );
  const onGroupPage = useCallback((p: number) => setGroupPage(p), []);

  // The Worker returns people alphabetically (stable sort keeps that order among equal counts).
  const sortedPeople = sort === 'count' ? [...people].sort((a, b) => b.faceCount - a.faceCount) : people;
  const shownPeople = sortedPeople.slice(offset, offset + size);
  const groupOffset = (groupPage - 1) * groupSize;
  const shownGroups = groups.slice(groupOffset, groupOffset + groupSize);

  return (
    <Stack gap="lg">
      <Title order={2}>People</Title>
      {groupsQuery.error != null && <Text c="red">Could not load unnamed faces</Text>}

      {loaded && people.length === 0 && groups.length === 0 && (
        <Text c="dimmed">No faces yet. Index some photos and faces will appear here to name.</Text>
      )}

      {people.length > 0 && (
        <>
          <Select
            aria-label="Sort people"
            data={SORT_OPTIONS}
            value={sort}
            allowDeselect={false}
            w={170}
            onChange={(value) => update({ sort: value === 'name' ? null : value }, { resetPage: true })}
          />
          <SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }} spacing="md">
            {shownPeople.map((p) => (
              <UnstyledButton key={p.id} component={Link} to={`/people/${p.id}`}>
                <Card withBorder padding="sm">
                  <Stack gap={6} align="center">
                    {p.cover ? (
                      <FaceTile face={{ ...p.cover, personName: null }} size={112} />
                    ) : (
                      <Text c="dimmed" size="sm" h={112} lh="112px">
                        No cover
                      </Text>
                    )}
                    <Text fw={600} ta="center" lineClamp={1}>
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
          <ListPagination
            page={page}
            size={size}
            total={people.length}
            sizes={PEOPLE_PAGE_SIZES}
            onPage={onPeoplePage}
            onSize={(s) => update({ size: s }, { resetPage: true })}
          />
        </>
      )}

      {groups.length > 0 && (
        <Stack gap="md">
          <Title order={3}>Unnamed groups</Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {shownGroups.map((g) => (
              <GroupCard
                key={g.faces[0].id}
                group={g}
                people={people}
                onDone={(key) => setHidden((prev) => new Set(prev).add(key))}
              />
            ))}
          </SimpleGrid>
          <ListPagination
            page={groupPage}
            size={groupSize}
            total={groups.length}
            hasMore={hasNextPage}
            sizes={GROUP_PAGE_SIZES}
            onPage={onGroupPage}
            onSize={(s) => {
              setGroupSize(s);
              setGroupPage(1);
            }}
          />
        </Stack>
      )}
    </Stack>
  );
};

export default People;
