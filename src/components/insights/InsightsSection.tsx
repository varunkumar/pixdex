import { Button, Group, Text, Title } from '@mantine/core';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import type { InsightTopic } from '../../types/api';
import FactTiles from './FactTiles';
import OnThisDay from './OnThisDay';

const TOPICS: InsightTopic[] = ['time', 'gear', 'wildlife', 'people'];
const TOPIC_LABEL: Record<InsightTopic, string> = { time: 'Time', gear: 'Gear', wildlife: 'Wildlife', people: 'People', places: 'Places' };
const ONE_HOUR = 60 * 60 * 1000;

/** Today in the browser's time zone, YYYY-MM-DD. */
function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "On this day", then the facts about the viewer's own photos. Renders nothing until there is something to show. */
const InsightsSection = () => {
  const [params, setParams] = useSearchParams();
  const date = localDate();
  const onThisDay = useQuery({
    queryKey: ['on-this-day', date],
    queryFn: () => workerApiClient.getOnThisDay(date),
    staleTime: ONE_HOUR,
  });
  const topics = useQueries({
    queries: TOPICS.map((topic) => ({
      queryKey: ['insights', topic],
      queryFn: () => workerApiClient.getInsights(topic),
      // People facts carry names, which can change on another page; the Worker answers from its cache.
      staleTime: topic === 'people' ? 0 : ONE_HOUR,
    })),
  });

  const loaded = TOPICS.map((topic, i) => ({ topic, query: topics[i], facts: topics[i].data?.facts ?? [] }));
  const withFacts = loaded.filter((t) => t.facts.length > 0);
  const wanted = loaded.find((t) => t.topic === params.get('topic'));
  // A topic that finished with nothing behaves like All: its chip is not shown, so it cannot be left selected.
  const selected = wanted && (wanted.facts.length > 0 || wanted.query.isPending || wanted.query.isError) ? wanted.topic : null;
  const visible = loaded.filter((t) => selected === null || t.topic === selected);
  const failed = visible.filter((t) => t.query.isError);
  const facts = visible.flatMap((t) => t.facts);

  const choose = (topic: InsightTopic | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (topic) next.set('topic', topic);
      else next.delete('topic');
      return next;
    });

  return (
    <>
      {onThisDay.data && onThisDay.data.years.length > 0 && <OnThisDay data={onThisDay.data} />}
      {(withFacts.length > 0 || failed.length > 0) && (
        <section>
          <Title order={2} size="h4" mb="sm">
            Your photo habits
          </Title>
          {withFacts.length > 0 && (
            <Group gap="xs" mb="sm" role="group" aria-label="Topic">
              {[null, ...withFacts.map((t) => t.topic)].map((topic) => (
                <Button
                  key={topic ?? 'all'}
                  size="compact-md"
                  radius="xl"
                  variant={selected === topic ? 'filled' : 'default'}
                  aria-pressed={selected === topic}
                  onClick={() => choose(topic)}
                >
                  {topic ? TOPIC_LABEL[topic] : 'All'}
                </Button>
              ))}
            </Group>
          )}
          {facts.length > 0 && <FactTiles facts={facts} />}
          {failed.map(({ topic, query }) => (
            <Group key={topic} gap="xs" mt="sm">
              <Text size="sm" c="red">
                Could not load {topic} facts.
              </Text>
              <Button size="compact-sm" variant="default" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </Group>
          ))}
        </section>
      )}
    </>
  );
};

export default InsightsSection;
