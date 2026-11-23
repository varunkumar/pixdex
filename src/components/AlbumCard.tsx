import { ActionIcon, Badge, Box, Center, Image, Text, Tooltip } from '@mantine/core';
import { useState } from 'react';
import { MdPhoto } from 'react-icons/md';
import { TbShare } from 'react-icons/tb';
import { Link, useLocation } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { formatPhotoDate } from '../services/exif';
import type { AlbumSummary } from '../types/api';
import ShareAlbumModal from './ShareAlbumModal';
import { AvatarStack, UserAvatar } from './UserAvatar';

/** Uniform 4:3 cover-first tile: name and count over the cover, who it is shared with at the bottom right. */
const AlbumCard = ({ album }: { album: AlbumSummary }) => {
  const location = useLocation();
  const [sharing, setSharing] = useState(false);
  const isOwner = album.role === 'owner';
  const sharedWith = isOwner ? (album.sharedWith ?? []) : [];
  const date = formatPhotoDate(album.latestDate);
  const cover = album.coverThumbnailUrl ? workerApiClient.thumbnailUrl({ thumbnailUrl: album.coverThumbnailUrl }) : '';
  const hasAvatars = sharedWith.length > 0 || (album.role === 'viewer' && !!album.ownerEmail);
  // Avatars shown: up to 3 sharees plus a "+N" bubble, or the single owner avatar.
  const avatarCount = album.role === 'viewer' ? 1 : Math.min(sharedWith.length, 3) + (sharedWith.length > 3 ? 1 : 0);

  return (
    <div className="pdx-album">
      <Link
        to={`/albums/${encodeURIComponent(album.name)}`}
        // Lets "All albums" return to this listing with its sort and page intact.
        state={{ albumsList: `${location.pathname}${location.search}` }}
        className="pdx-album-link"
      >
        {cover ? (
          <Image src={cover} alt={album.name} fit="cover" h="100%" w="100%" />
        ) : (
          <Center h="100%" bg="var(--mantine-color-default-hover)">
            <Box c="dimmed" fz={40} lh={1}>
              <MdPhoto aria-hidden />
            </Box>
          </Center>
        )}
        <div className="pdx-album-text" style={hasAvatars ? { paddingRight: 28 + 20 * Math.min(avatarCount, 4) } : undefined}>
          <Text fw={600} size="sm" lineClamp={1} inherit>
            {album.name}
          </Text>
          <Text size="xs" lineClamp={2} inherit style={{ opacity: 0.85 }}>
            {album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}
            {date && ` · ${date}`}
          </Text>
        </div>
      </Link>
      {album.role === 'viewer' && (
        <Badge className="pdx-album-chip" size="sm" variant="filled" color="grape">
          Shared with you
        </Badge>
      )}
      {hasAvatars && (
        <div className="pdx-album-people">
          {album.role === 'viewer' && album.ownerEmail ? (
            <UserAvatar email={album.ownerEmail} size={26} />
          ) : (
            <AvatarStack emails={sharedWith} size={26} />
          )}
        </div>
      )}
      {isOwner && (
        <>
          <div className="pdx-tile-actions">
            <Tooltip label="Share">
              <ActionIcon variant="filled" color="dark" size="md" aria-label="Share" onClick={() => setSharing(true)}>
                <TbShare aria-hidden />
              </ActionIcon>
            </Tooltip>
          </div>
          {sharing && (
            <ShareAlbumModal album={album.name} sharedWith={sharedWith} opened onClose={() => setSharing(false)} />
          )}
        </>
      )}
    </div>
  );
};

export default AlbumCard;
