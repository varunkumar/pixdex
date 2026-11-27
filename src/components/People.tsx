import { usePageTitle } from '../hooks/usePageTitle';
import {
  ActionIcon,
  Box,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { TbUsers, TbX } from "react-icons/tb";
import { Link } from "react-router-dom";
import { useRememberAddress } from "../hooks/useLastAddress";
import { useListParams } from "../hooks/useListParams";
import { useReviewQueue } from "../hooks/useReviewQueue";
import { workerApiClient } from "../services/api/WorkerApiClient";
import {
  matchAfterNaming,
  refreshAfterIgnoring,
  refreshAfterNaming,
} from "../services/matchQueue";
import { errorMessage, UNNAMED_PERSON } from "../services/peopleKeys";
import type { FaceGroup, PersonSummary } from "../types/api";
import FaceTile from "./FaceTile";
import ListPagination from "./ListPagination";
import PageLoading from "./PageLoading";
import SortIcons from "./SortIcons";
import PersonLabelEditor from "./PersonLabelEditor";
import IgnoredFaces from "./IgnoredFaces";

const GROUP_TILES = 8;

const SORT_OPTIONS = [
  { value: "name", label: "Alphabetical", text: "A-Z" },
  { value: "count", label: "Most faces", icon: TbUsers },
];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

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
  const [name, setName] = useState("");
  const faceIds = group.faces.map((f) => f.id);

  // The faces are saved: close the group at once and look for more matches in the background.
  const finish = (personId: string) => {
    refreshAfterNaming(queryClient, faceIds);
    matchAfterNaming(queryClient, personId, faceIds);
    onDone(faceIds[0]);
  };

  const create = useMutation({
    mutationFn: async (newName: string) => {
      const person = await workerApiClient.createPerson(newName, faceIds);
      finish(person.id);
    },
  });
  const assign = useMutation({
    mutationFn: async (personId: string) => {
      await workerApiClient.assignFaces(personId, faceIds);
      finish(personId);
    },
  });

  const ignore = useMutation({
    mutationFn: async (ids: string[]) => {
      await workerApiClient.ignoreFaces(ids);
      refreshAfterIgnoring(queryClient, ids);
    },
  });

  const busy = create.isPending || assign.isPending || ignore.isPending;
  const error = create.error ?? assign.error ?? ignore.error;

  return (
    <Card withBorder data-testid="face-group">
      <Stack gap="sm">
        <Group gap="xs">
          {[...group.faces]
            .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)
            .slice(0, GROUP_TILES)
            .map((f, i) => (
              <Box key={f.id} pos="relative">
                <FaceTile face={f} size={64} />
                <ActionIcon
                  size="xs"
                  radius="xl"
                  variant="default"
                  pos="absolute"
                  top={-6}
                  right={-6}
                  disabled={busy}
                  title="Ignore this face"
                  aria-label={`Ignore face ${i + 1} of ${group.faces.length}`}
                  onClick={() => ignore.mutate([f.id])}
                >
                  <TbX />
                </ActionIcon>
              </Box>
            ))}
        </Group>
        <Text size="xs" c="dimmed">
          {plural(group.faces.length, "face")}
        </Text>
        {!open ? (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              disabled={busy}
              onClick={() => setOpen(true)}
            >
              Name this group
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              loading={ignore.isPending}
              disabled={busy}
              onClick={() => ignore.mutate(faceIds)}
            >
              Ignore group
            </Button>
          </Group>
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
                disabled={name.trim() === "" || busy}
                onClick={() => create.mutate(name.trim())}
              >
                Save name
              </Button>
              <Button
                size="xs"
                variant="subtle"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
            </Group>
            {people.length > 0 && (
              <Select
                aria-label="Existing person"
                placeholder="Or add to an existing person"
                size="xs"
                searchable
                data={people.map((p) => ({
                  value: p.id,
                  label: p.name ?? UNNAMED_PERSON,
                }))}
                value={null}
                disabled={busy}
                onChange={(value) => value && assign.mutate(value)}
              />
            )}
          </Stack>
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
  useRememberAddress();
  usePageTitle('People');
  const { params, page, size, offset, update } = useListParams(
    12,
    PEOPLE_PAGE_SIZES,
  );
  const sort =
    SORT_OPTIONS.find((o) => o.value === params.get("sort"))?.value ?? "name";
  // In the address, like the people page number, so Back returns to the same groups.
  const groupPage = Math.max(1, Math.floor(Number(params.get("groups"))) || 1);
  const requestedGroupSize = Number(params.get("groupSize"));
  const groupSize =
    GROUP_PAGE_SIZES.find((s) => s === requestedGroupSize) ??
    GROUP_PAGE_SIZES[0];
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const {
    data: people = [],
    isSuccess: peopleLoaded,
    isError: peopleFailed,
  } = useQuery({
    queryKey: ["people"],
    queryFn: () => workerApiClient.getPeople(),
  });
  const reviewQueue = useReviewQueue();
  const pending = reviewQueue.data?.reduce((n, p) => n + p.count, 0) ?? 0;
  const groupsQuery = useInfiniteQuery({
    queryKey: ["people-groups"],
    queryFn: ({ pageParam }) => workerApiClient.getFaceGroups(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // The Worker returns unassigned faces of albums the caller owns only (nothing for a pure viewer).
  const groups = (
    groupsQuery.data?.pages.flatMap((p) => p.groups) ?? []
  ).filter((g) => g.faces.length > 0 && !hidden.has(g.faces[0].id));
  const loaded = peopleLoaded && groupsQuery.isSuccess;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = groupsQuery;

  // Groups come from the Worker a cursor page at a time: load more until the current page is full.
  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      groups.length < groupPage * groupSize
    )
      void fetchNextPage();
  }, [
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    groups.length,
    groupPage,
    groupSize,
  ]);

  const onPeoplePage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    [update],

  );
  const onGroupPage = useCallback(
    (p: number, replace?: boolean) =>
      update({ groups: p === 1 ? null : p }, { replace, keepScroll: true }),
    [update],
  );

  // The Worker returns people alphabetically (stable sort keeps that order among equal counts).
  const sortedPeople =
    sort === "count"
      ? [...people].sort((a, b) => b.faceCount - a.faceCount)
      : people;
  const shownPeople = sortedPeople.slice(offset, offset + size);
  const groupOffset = (groupPage - 1) * groupSize;
  const shownGroups = groups.slice(groupOffset, groupOffset + groupSize);

  return (
    <Stack gap="lg">
      <Title order={1} size="h2">
        People
      </Title>
      {pending > 0 && (
        <Button component={Link} to="/review" variant="light" w="fit-content">
          {pending} {pending === 1 ? "match" : "matches"} to review
        </Button>
      )}
      {groupsQuery.error != null && (
        <Text c="red">Could not load unnamed faces</Text>
      )}

      {!loaded && !peopleFailed && groupsQuery.error == null && (
        <PageLoading label="Loading people" />
      )}

      {loaded && people.length === 0 && groups.length === 0 && (
        <Text c="dimmed">
          No faces yet. Index some photos and faces will appear here to name.
        </Text>
      )}

      {people.length > 0 && (
        <>
          <Group justify="flex-end">
            <SortIcons
              label="Sort people"
              options={SORT_OPTIONS}
              value={sort}
              onChange={(value) =>
                update(
                  { sort: value === "name" ? null : value },
                  { resetPage: true },
                )
              }
            />
          </Group>
          <SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }} spacing="md">
            {shownPeople.map((p) => (
              <Stack key={p.id} gap={4} align="stretch">
                <UnstyledButton component={Link} to={`/people/${p.id}`}>
                  <Card withBorder padding="sm">
                    <Stack gap={6} align="center">
                      {p.cover ? (
                        <FaceTile
                          face={{ ...p.cover, personName: null }}
                          size={112}
                        />
                      ) : (
                        <Text c="dimmed" size="sm" h={112} lh="112px">
                          No cover
                        </Text>
                      )}
                      <Text
                        fw={600}
                        ta="center"
                        lineClamp={1}
                        c={p.name === null ? "dimmed" : undefined}
                      >
                        {p.name ?? UNNAMED_PERSON}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {plural(p.photoCount, "photo")},{" "}
                        {plural(p.faceCount, "face")}
                      </Text>
                    </Stack>
                  </Card>
                </UnstyledButton>
                {!p.canEdit && (
                  <PersonLabelEditor personId={p.id} name={p.name} />
                )}
              </Stack>
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
          <Title order={2} size="h3">
            Unnamed groups
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {shownGroups.map((g) => (
              <GroupCard
                key={g.faces[0].id}
                group={g}
                people={people.filter((p) => p.canEdit)}
                onDone={(key) => setHidden((prev) => new Set(prev).add(key))}
              />
            ))}
          </SimpleGrid>
          <ListPagination
            page={groupPage}
            size={groupSize}
            total={groups.length}
            hasMore={hasNextPage}
            // Still loading up to the requested page: do not fall back to an earlier one yet.
            settled={!hasNextPage || groups.length >= groupPage * groupSize}
            sizes={GROUP_PAGE_SIZES}
            onPage={onGroupPage}
            onSize={(s) =>
              update(
                {
                  groupSize: s === GROUP_PAGE_SIZES[0] ? null : s,
                  groups: null,
                },
                { keepScroll: true },
              )
            }
          />
        </Stack>
      )}

      <IgnoredFaces />
    </Stack>
  );
};

export default People;
