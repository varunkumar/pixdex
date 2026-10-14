import { Box, Card, Center, Image, Stack, Text } from '@mantine/core';
import { MdPhoto } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { formatPhotoDate } from '../services/exif';
import type { AlbumSummary } from '../types/api';

const AlbumCard = ({ album }: { album: AlbumSummary }) => {
  const date = formatPhotoDate(album.latestDate);
  const cover = album.coverThumbnailUrl
    ? workerApiClient.thumbnailUrl({ thumbnailUrl: album.coverThumbnailUrl })
    : '';

  return (
    <Card
      withBorder
      padding={0}
      radius="md"
      component={Link}
      to={`/albums/${encodeURIComponent(album.name)}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <Card.Section>
        {cover ? (
          <Image src={cover} alt={album.name} h={180} fit="cover" />
        ) : (
          <Center h={180} bg="var(--mantine-color-default-hover)">
            <Box c="dimmed" fz={40} lh={1}>
              <MdPhoto aria-hidden />
            </Box>
          </Center>
        )}
      </Card.Section>
      <Stack gap={2} p="md">
        <Text fw={600} lineClamp={1}>
          {album.name}
        </Text>
        <Text size="sm" c="dimmed">
          {album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}
          {date && ` · ${date}`}
        </Text>
      </Stack>
    </Card>
  );
};

export default AlbumCard;
