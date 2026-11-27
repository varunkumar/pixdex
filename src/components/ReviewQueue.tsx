import { usePageTitle } from '../hooks/usePageTitle';
import { Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLastAddress } from '../hooks/useLastAddress';
import { useReviewQueue } from '../hooks/useReviewQueue';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { UNNAMED_PERSON } from '../services/peopleKeys';
import BackLink from './BackLink';
import FaceTile from './FaceTile';
import PageLoading from './PageLoading';

const FACE = 56;

/** Everyone with auto matches waiting to be confirmed, most first. */
const ReviewQueue = () => {
  usePageTitle('To review');
  const peopleList = useLastAddress('/people');
  const queue = useReviewQueue();
  const people = useQuery({ queryKey: ['people'], queryFn: () => workerApiClient.getPeople() });
  const byId = new Map((people.data ?? []).map((p) => [p.id, p]));
  const rows = (queue.data ?? []).flatMap(({ id, count }) => {
    const person = byId.get(id);
    return person ? [{ person, count }] : [];
  });
  const failed = queue.isError || people.isError;
  const loaded = queue.data !== undefined && people.data !== undefined;

  return (
    <Stack gap="lg">
      <BackLink to={peopleList}>All people</BackLink>
      <Title order={1} size="h2">To review</Title>
      {failed && (
        <Group gap="xs">
          <Text size="sm" c="red">
            Could not load the matches to review
          </Text>
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              void queue.refetch();
              void people.refetch();
            }}
          >
            Try again
          </Button>
        </Group>
      )}
      {!failed && !loaded && <PageLoading label="Loading matches" />}
      {loaded && rows.length === 0 && <Text c="dimmed">Nothing to review.</Text>}
      {rows.map(({ person, count }) => {
        const name = person.name ?? UNNAMED_PERSON;
        return (
          <Card key={person.id} withBorder padding="sm">
            <Group gap="sm" wrap="nowrap">
              {person.cover ? (
                <FaceTile face={{ ...person.cover, personName: null }} size={FACE} />
              ) : (
                <Text c="dimmed" size="xs" w={FACE} ta="center">
                  No cover
                </Text>
              )}
              <Stack gap={0} flex={1} miw={0}>
                <Text fw={600} lineClamp={1}>
                  {name}
                </Text>
                <Text size="sm" c="dimmed">
                  {count} to review
                </Text>
              </Stack>
              <Button component={Link} to={`/people/${person.id}/review`} size="xs" variant="light" aria-label={`Review ${name}`}>
                Review
              </Button>
            </Group>
          </Card>
        );
      })}
    </Stack>
  );
};

export default ReviewQueue;
