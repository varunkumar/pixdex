import { Badge, Box, Button, Card, Center, Group, Image, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { MdPhoto } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { formatPhotoDate } from '../services/exif';
import type { AlbumSummary } from '../types/api';
import ShareAlbumModal from './ShareAlbumModal';
import { AvatarStack, UserAvatar } from './UserAvatar';

/** `eager` covers (the first row) load at once; the rest wait until they come near the viewport. */
const AlbumCard = ({ album, eager = false }: { album: AlbumSummary; eager?: boolean }) => {
  const [sharing, setSharing] = useState(false);
  const isOwner = album.role === 'owner';
  const shared = isOwner && (album.sharedWith?.length ?? 0) > 0;
  const date = formatPhotoDate(album.latestDate);
  const cover = album.coverThumbnailUrl ? workerApiClient.thumbnailUrl({ thumbnailUrl: album.coverThumbnailUrl }) : '';

  return (
    <Card withBorder padding={0} radius="md">
      <Link
        to={`/albums/${encodeURIComponent(album.name)}`}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        <Card.Section>
          {cover ? (
            <Image
              src={cover}
              alt={album.name}
              h={180}
              fit="contain"
              bg="var(--mantine-color-default-hover)"
              loading={eager ? undefined : 'lazy'}
            />
          ) : (
            <Center h={180} bg="var(--mantine-color-default-hover)">
              <Box c="dimmed" fz={40} lh={1}>
                <MdPhoto aria-hidden />
              </Box>
            </Center>
          )}
        </Card.Section>
        <Stack gap={2} p="md" pb={isOwner ? 'xs' : 'md'}>
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} lineClamp={1}>
              {album.name}
            </Text>
            {album.role === 'viewer' && (
              <Badge size="sm" variant="light" color="grape">
                Shared with you
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}
            {date && ` · ${date}`}
          </Text>
          {shared && (
            <Group gap="xs" mt={4} wrap="nowrap">
              <AvatarStack emails={album.sharedWith ?? []} />
              <Text size="xs" c="dimmed">
                Shared with {album.sharedWith!.length}
              </Text>
            </Group>
          )}
          {album.role === 'viewer' && album.ownerEmail && (
            <Group gap="xs" mt={4} wrap="nowrap">
              <UserAvatar email={album.ownerEmail} size="sm" />
              <Text size="xs" c="dimmed" lineClamp={1}>
                Shared by {album.ownerEmail}
              </Text>
            </Group>
          )}
        </Stack>
      </Link>
      {isOwner && (
        <>
          <Button variant="subtle" size="compact-sm" mx="md" mb="md" w="fit-content" onClick={() => setSharing(true)}>
            Share
          </Button>
          {sharing && (
            <ShareAlbumModal
              album={album.name}
              sharedWith={album.sharedWith ?? []}
              opened
              onClose={() => setSharing(false)}
            />
          )}
        </>
      )}
    </Card>
  );
};

export default AlbumCard;
