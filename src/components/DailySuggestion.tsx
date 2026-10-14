import { Anchor, Badge, Button, Card, Group, Image, Skeleton, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { getOriginalUrl } from '../services/originals';
import PhotoMeta from './PhotoMeta';

const DailySuggestion = () => {
  const {
    data: suggestion,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['dailyPick'],
    queryFn: () => workerApiClient.getDailyPick(),
  });

  const handleCopyToClipboard = () => {
    if (!suggestion) return;

    const content = `${suggestion.suggestedCaption}\n\n${suggestion.suggestedHashtags
      .map((tag) => `#${tag}`)
      .join(' ')}`;
    navigator.clipboard.writeText(content).then(
      () => {
        notifications.show({ title: 'Copied to clipboard', message: '', color: 'green', autoClose: 2000 });
      },
      (err: Error) => {
        notifications.show({ title: 'Failed to copy', message: err.message, color: 'red', autoClose: 3000 });
      }
    );
  };

  const originalUrl = suggestion ? getOriginalUrl(suggestion.photo) : null;

  return (
    <Card withBorder maw={1100} mx="auto" w="100%">
      <Title order={3} mb="md">
        Today's Instagram Pick
      </Title>
      {isLoading ? (
        <Stack>
          <Skeleton height={400} />
          <Skeleton height={20} />
          <Skeleton height={100} />
          <Skeleton height={40} />
        </Stack>
      ) : error ? (
        <Text c="red">
          {error instanceof Error ? error.message : 'An error occurred while loading the suggestion'}
        </Text>
      ) : suggestion ? (
        <Stack>
          <Image
            src={workerApiClient.thumbnailUrl(suggestion.photo)}
            alt={suggestion.photo.description ?? suggestion.photo.filename ?? suggestion.photo.id}
            radius="md"
            fit="contain"
            mah={500}
          />
          <PhotoMeta photo={suggestion.photo} />

          <Text fw={700}>Why this photo?</Text>
          <Text>{suggestion.reason}</Text>

          <Text fw={700}>Suggested Caption</Text>
          <Textarea value={suggestion.suggestedCaption} readOnly rows={4} />

          <Text fw={700}>Suggested Hashtags</Text>
          <Group gap="xs">
            {suggestion.suggestedHashtags.map((tag) => (
              <Badge key={tag} variant="light">
                #{tag}
              </Badge>
            ))}
          </Group>

          <Button onClick={handleCopyToClipboard} w="fit-content">
            Copy to Clipboard
          </Button>

          {originalUrl && (
            <Anchor href={originalUrl} target="_blank" rel="noopener noreferrer">
              View Original
            </Anchor>
          )}
        </Stack>
      ) : (
        <Text>No suggestion available</Text>
      )}
    </Card>
  );
};

export default DailySuggestion;
