import { Link, Text, VStack } from '@chakra-ui/react';
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
    <VStack align="stretch" spacing={0} mb={2} fontSize="xs" color="gray.500">
      {(date || location) && (
        <Text>
          {date}
          {date && location && ' · '}
          {location && (
            <Link href={location} isExternal color="teal.500">
              View location
            </Link>
          )}
        </Text>
      )}
      {camera.length > 0 && <Text>{camera.join(' · ')}</Text>}
    </VStack>
  );
};

export default PhotoMeta;
