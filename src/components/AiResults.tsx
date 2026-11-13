import { Badge, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { RESULT_LIMIT, type AiSearchResult, type RankedPhoto } from '../services/aiSearch/pipeline';
import PhotoCard from './PhotoCard';

const ResultFooter = ({ item }: { item: RankedPhoto }) => (
  <Stack gap={2}>
    <Text size="xs" c="dimmed">
      matched: {item.hits.join(', ')}
    </Text>
    {item.textSpace && (
      <Text size="xs" c="dimmed">
        Text space: {Math.round(item.textSpace.score * 100)}% ({item.textSpace.side})
      </Text>
    )}
    <Text size="xs" c="dimmed">
      Rating: {item.rating.toFixed(1)}
    </Text>
  </Stack>
);

/** The ranked AI results: per-keyword badges, the "people photos hidden" line and at most 48 cards. */
export default function AiResults({ result }: { result: AiSearchResult }) {
  const noMatches = result.keywords.filter((k) => !k.failed && k.total === 0);
  const failed = result.keywords.filter((k) => k.failed);
  const items = result.items.slice(0, RESULT_LIMIT);

  return (
    <Stack gap="sm">
      {(noMatches.length > 0 || failed.length > 0) && (
        <Group gap={6}>
          {noMatches.map((k) => (
            <Badge key={k.term} variant="outline" color="gray" size="sm">
              {k.term}: no matches
            </Badge>
          ))}
          {failed.map((k) => (
            <Badge key={k.term} variant="light" color="red" size="sm">
              {k.term}: failed
            </Badge>
          ))}
        </Group>
      )}

      {items.length === 0 && <Text c="dimmed">No photos found. Try editing the keywords and searching again.</Text>}

      {items.length > 0 && (
        <>
          {result.hiddenPeople > 0 && (
            <Text size="sm" c="dimmed">
              {result.hiddenPeople} people photos hidden.
            </Text>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {items.map((item) => (
              <PhotoCard key={item.photo.id} photo={item.photo} footer={<ResultFooter item={item} />} />
            ))}
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
