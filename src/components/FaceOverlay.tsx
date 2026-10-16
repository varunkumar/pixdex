import { Badge, Box } from '@mantine/core';
import type { SerializedFace } from '../types/api';

/** Numbered boxes drawn over a photo; the numbers match the rows in the People card. */
const FaceOverlay = ({ faces }: { faces: SerializedFace[] }) => (
  <>
    {faces.map((f, i) => (
      <Box
        key={f.id}
        data-testid="face-box"
        aria-hidden="true"
        pos="absolute"
        style={{
          left: `${f.bbox.x * 100}%`,
          top: `${f.bbox.y * 100}%`,
          width: `${f.bbox.w * 100}%`,
          height: `${f.bbox.h * 100}%`,
          border: '2px solid var(--mantine-color-blue-5)',
          borderRadius: 4,
          pointerEvents: 'none',
        }}
      >
        <Badge data-testid={`face-box-${i + 1}`} size="xs" circle style={{ position: 'absolute', top: -8, left: -8 }}>
          {i + 1}
        </Badge>
      </Box>
    ))}
  </>
);

export default FaceOverlay;
