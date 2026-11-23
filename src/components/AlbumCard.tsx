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

/**
 * Uniform 4:3 cover tile with the album name always shown below it. On a mouse device the count and date, the sharing
 * avatars and the Share button appear over the cover on hover (or focus); on touch devices the count and date join the
 * name line and the rest stays visible.
 */
const AlbumCard = ({ album }: { album: AlbumSummary }) => {
  const location = useLocation();
  const [sharing, setSharing] = useState(false);
  const isOwner = album.role === 'owner';
  const sharedWith = isOwner ? (album.sharedWith ?? []) : [];
  const date = formatPhotoDate(album.latestDate);
  const cover = album.coverThumbnailUrl ? workerApiClient.thumbnailUrl({ thumbnailUrl: album.coverThumbnailUrl }) : '';
  const count = `${album.photoCount} ${album.photoCount === 1 ? 'photo' : 'photos'}`;
  const sharing_ =
    sharedWith.length > 0
      ? `shared with ${sharedWith.join(', ')}`
      : album.role === 'viewer' && album.ownerEmail
        ? `shared by ${album.ownerEmail}`
        : null;
  const hasAvatars = sharedWith.length > 0 || (album.role === 'viewer' && !!album.ownerEmail);
  // Avatars shown: up to 3 sharees plus a "+N" bubble, or the single owner avatar.
  const avatarCount = album.role === 'viewer' ? 1 : Math.min(sharedWith.length, 3) + (sharedWith.length > 3 ? 1 : 0);

  return (
    <div className="pdx-album-item">
      <div className="pdx-album">
        <Link
          to={`/albums/${encodeURIComponent(album.name)}`}
          // Lets "All albums" return to this listing with its sort and page intact.
          state={{ albumsList: `${location.pathname}${location.search}` }}
          className="pdx-album-link"
          // The visible text is hover-only on a mouse, so the link carries everything in its name.
          aria-label={[album.name, count, date, sharing_].filter(Boolean).join(', ')}
        >
          {cover ? (
            <Image src={cover} alt="" fit="cover" h="100%" w="100%" />
          ) : (
            <Center h="100%" bg="var(--mantine-color-default-hover)">
              <Box c="dimmed" fz={40} lh={1}>
                <MdPhoto aria-hidden />
              </Box>
            </Center>
          )}
          <div
            className="pdx-album-text"
            style={hasAvatars ? { paddingRight: 28 + 20 * Math.min(avatarCount, 4) } : undefined}
          >
            <Text size="xs" lineClamp={2} inherit>
              {count}
              {date && ` · ${date}`}
            </Text>
          </div>
        </Link>
        {album.role === 'viewer' && (
          <Badge className="pdx-album-chip pdx-reveal" size="sm" variant="filled" color="grape">
            Shared with you
          </Badge>
        )}
        {hasAvatars && (
          <div className="pdx-album-people pdx-reveal">
            {album.role === 'viewer' && album.ownerEmail ? (
              <UserAvatar email={album.ownerEmail} size={26} />
            ) : (
              <AvatarStack emails={sharedWith} size={26} />
            )}
          </div>
        )}
        {isOwner && (
          <div className="pdx-tile-actions">
            <Tooltip label="Share">
              <ActionIcon
                variant="filled"
                color="dark"
                size="md"
                aria-label={`Share ${album.name}`}
                onClick={() => setSharing(true)}
              >
                <TbShare aria-hidden />
              </ActionIcon>
            </Tooltip>
          </div>
        )}
      </div>
      <div className="pdx-album-cap">
        <span className="pdx-album-name">{album.name}</span>
        <span className="pdx-album-cap-meta">
          {' · '}
          {count}
          {date && ` · ${date}`}
        </span>
      </div>
      {isOwner && sharing && (
        <ShareAlbumModal album={album.name} sharedWith={sharedWith} opened onClose={() => setSharing(false)} />
      )}
    </div>
  );
};

export default AlbumCard;
