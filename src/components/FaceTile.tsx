import { Box, Stack, Text } from '@mantine/core';
import { workerApiClient } from '../services/api/WorkerApiClient';
import type { SerializedFace } from '../types/api';

/** A face cropped out of the 400 px photo thumbnail using its normalised bbox. */
const FaceTile = ({ face, size = 72, index }: { face: SerializedFace; size?: number; index?: number }) => {
  const { x, y, w, h } = face.bbox;
  // Scale so the bbox fills the tile, then shift so the bbox origin sits at the tile origin.
  const bgW = w > 0 ? size / w : size;
  const bgH = h > 0 ? size / h : size;
  const src = workerApiClient.thumbnailUrl(face);
  return (
    <Stack gap={2} align="center" w={size}>
      <Box
        role="img"
        aria-label={index != null ? `Face ${index + 1}` : (face.personName ?? 'Unnamed face')}
        data-testid="face-tile"
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: 'var(--mantine-color-default-hover)',
          backgroundImage: src ? `url("${src}")` : undefined,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${bgW}px ${bgH}px`,
          backgroundPosition: `${-x * bgW}px ${-y * bgH}px`,
        }}
      />
      {face.personName && (
        <Text size="xs" ta="center" lineClamp={1} w={size}>
          {face.personName}
        </Text>
      )}
    </Stack>
  );
};

export default FaceTile;
