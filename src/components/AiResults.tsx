import { Badge, Group, Stack, Text } from '@mantine/core';
import { RESULT_LIMIT, type AiSearchResult, type RankedPhoto } from '../services/aiSearch/pipeline';
import PhotoGrid from './PhotoGrid';

const resultNote = (item: RankedPhoto): string =>
  [
    `matched: ${item.hits.join(', ')}`,
    item.textSpace ? `Text space: ${Math.round(item.textSpace.score * 100)}% (${item.textSpace.side})` : null,
    `Rating: ${item.rating.toFixed(1)}`,
  ]
    .filter(Boolean)
    .join(' · ');

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
          <PhotoGrid
            photos={items.map((item) => item.photo)}
            note={(photo) => resultNote(items.find((item) => item.photo.id === photo.id)!)}
          />
        </>
      )}
    </Stack>
  );
}
