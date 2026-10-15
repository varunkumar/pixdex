import { Anchor, Badge, Card, Group, Image, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { getOriginalUrl } from '../services/originals';
import { shortDescription } from '../services/text';
import type { SerializedPhoto } from '../types/api';
import PhotoMeta from './PhotoMeta';

const MAX_LISTING_TAGS = 5;

const PhotoCard = ({ photo, footer }: { photo: SerializedPhoto; footer?: ReactNode }) => {
  const originalUrl = getOriginalUrl(photo);
  const alt = shortDescription(photo.description, 80) || photo.filename || photo.id;

  return (
    <Card withBorder padding={0} radius="md" component="article">
      <Card.Section component={Link} to={`/photos/${photo.id}`} style={{ display: 'block' }}>
        <Image
          src={workerApiClient.thumbnailUrl(photo)}
          alt={alt}
          fit="contain"
          h={240}
          bg="var(--mantine-color-default-hover)"
        />
      </Card.Section>

      <Stack gap="xs" p="md">
        <Anchor component={Link} to={`/photos/${photo.id}`} c="inherit" underline="never">
          {photo.shortCaption && (
            <Text size="sm" fw={600}>
              {photo.shortCaption}
            </Text>
          )}
          <Text size="sm">{shortDescription(photo.description)}</Text>
        </Anchor>
        <PhotoMeta photo={photo} compact />
        <Group gap={6}>
          {photo.tags.slice(0, MAX_LISTING_TAGS).map((tag) => (
            <Badge key={tag} variant="light" size="sm">
              {tag}
            </Badge>
          ))}
          {photo.tags.length > MAX_LISTING_TAGS && (
            <Badge variant="outline" size="sm">
              +{photo.tags.length - MAX_LISTING_TAGS}
            </Badge>
          )}
        </Group>
        {originalUrl && (
          <Anchor href={originalUrl} target="_blank" rel="noopener noreferrer" size="sm">
            View Original
          </Anchor>
        )}
        {footer}
      </Stack>
    </Card>
  );
};

export default PhotoCard;
