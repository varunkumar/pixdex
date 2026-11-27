import { usePageTitle } from '../hooks/usePageTitle';
import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Image,
  Skeleton,
  Stack,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { copyText } from '../services/copy';
import { usePrefetchImage } from '../hooks/usePrefetchImage';
import { getOriginalImageUrl, getOriginalUrl } from '../services/originals';
import Lightbox from './Lightbox';
import PhotoMeta from './PhotoMeta';

const DailySuggestion = () => {
  usePageTitle('Daily pick');
  const [zoomOpen, setZoomOpen] = useState(false);
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
    const hashtags = suggestion.suggestedHashtags.map((tag) => `#${tag}`).join(' ');
    void copyText(`${suggestion.suggestedCaption}\n\n${hashtags}`);
  };

  const originalUrl = suggestion ? getOriginalUrl(suggestion.photo) : null;
  const originalImage = suggestion ? getOriginalImageUrl(suggestion.photo) : null;
  // Only fetch the (large) original once the viewer is opened.
  const originalStatus = usePrefetchImage(zoomOpen ? originalImage : null);
  const thumbnail = suggestion ? workerApiClient.thumbnailUrl(suggestion.photo) : '';
  const alt = suggestion ? (suggestion.photo.description ?? suggestion.photo.filename ?? suggestion.photo.id) : '';

  return (
    <Card withBorder maw={1100} mx="auto" w="100%">
      <Title order={1} size="h3" mb="md">
        Today's Instagram pick
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
          <UnstyledButton
            onClick={() => setZoomOpen(true)}
            aria-label="Open full-size photo"
            style={{ cursor: 'zoom-in' }}
          >
            <Image src={thumbnail} alt={alt} radius="md" fit="contain" mah={500} w="100%" />
          </UnstyledButton>
          {suggestion.photo.shortCaption && <Title order={2} size="h4">{suggestion.photo.shortCaption}</Title>}
          <PhotoMeta photo={suggestion.photo} />

          <Title order={2} fz="md">Why this photo?</Title>
          <Text>{suggestion.reason}</Text>

          <Title order={2} fz="md">Suggested caption</Title>
          <Textarea value={suggestion.suggestedCaption} readOnly rows={4} />

          <Title order={2} fz="md">Suggested hashtags</Title>
          <Group gap="xs">
            {suggestion.suggestedHashtags.map((tag) => (
              <Badge key={tag} variant="light">
                #{tag}
              </Badge>
            ))}
          </Group>

          <Button onClick={handleCopyToClipboard} w="fit-content">
            Copy to clipboard
          </Button>

          {originalUrl && (
            <Anchor href={originalUrl} target="_blank" rel="noopener noreferrer">
              View original
            </Anchor>
          )}
        </Stack>
      ) : (
        <Text>No suggestion available</Text>
      )}
      <Lightbox
        opened={zoomOpen}
        onClose={() => setZoomOpen(false)}
        thumbnailSrc={thumbnail}
        originalSrc={originalImage}
        originalStatus={originalStatus}
        alt={alt}
        title={suggestion?.photo.shortCaption ?? suggestion?.photo.filename ?? undefined}
        fallbackHref={originalUrl}
      />
    </Card>
  );
};

export default DailySuggestion;
