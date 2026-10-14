import { Anchor, Stack, Text } from '@mantine/core';
import type { SerializedPhoto } from '../types/api';
import { exifSummary, formatPhotoDate, mapsUrl } from '../services/exif';

/** Capture date, location link and camera details; `compact` is the one-line listing form. */
const PhotoMeta = ({ photo, compact = false }: { photo: SerializedPhoto; compact?: boolean }) => {
  const date = formatPhotoDate(photo.dateTime);
  // Listings show only the camera body; the detail page has the full details.
  const camera = compact ? (photo.cameraModel ? [photo.cameraModel] : []) : exifSummary(photo);
  const location = mapsUrl(photo);

  if (!date && camera.length === 0 && !location) return null;

  return (
    <Stack gap={0} mb="xs">
      {(date || location) && (
        <Text size="xs" c="dimmed">
          {date}
          {date && location && ' · '}
          {location && (
            <Anchor href={location} target="_blank" rel="noopener noreferrer" size="xs">
              View location
            </Anchor>
          )}
        </Text>
      )}
      {camera.length > 0 && (
        <Text size="xs" c="dimmed">
          {camera.join(' · ')}
        </Text>
      )}
    </Stack>
  );
};

export default PhotoMeta;
