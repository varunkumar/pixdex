import { Box, Stack, Text } from '@mantine/core';
import { workerApiClient } from '../services/api/WorkerApiClient';
import type { SerializedFace } from '../types/api';

/** A face: the sharp crop when the agent uploaded one, else cut out of the 400 px photo thumbnail by its bbox. */
const FaceTile = ({ face, size = 72, index }: { face: SerializedFace; size?: number; index?: number }) => {
  const { x, y, w, h } = face.bbox;
  // Scale so the bbox fills the tile, then shift so the bbox origin sits at the tile origin.
  const bgW = w > 0 ? size / w : size;
  const bgH = h > 0 ? size / h : size;
  const crop = face.cropUrl ? workerApiClient.thumbnailUrl({ thumbnailUrl: face.cropUrl }) : '';
  const src = crop || workerApiClient.thumbnailUrl(face);
  return (
    <Stack gap={2} align="center" w={size}>
      <Box
        role="img"
        aria-label={index != null ? `Face ${index + 1}` : (face.personName ?? 'Unnamed face')}
        data-testid="face-tile"
        style={{
          width: size,
          height: size,
          borderRadius: 'var(--mantine-radius-md)',
          backgroundColor: 'var(--mantine-color-default-hover)',
          backgroundImage: src ? `url("${src}")` : undefined,
          backgroundRepeat: 'no-repeat',
          backgroundSize: crop ? 'cover' : `${bgW}px ${bgH}px`,
          backgroundPosition: crop ? 'center' : `${-x * bgW}px ${-y * bgH}px`,
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
