import { Box, Image, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import type { AlbumFilter } from '../services/albumFilter';
import { workerApiClient } from '../services/api/WorkerApiClient';
import type { AlbumKnownTile, AlbumPersonTile, AlbumSpeciesTile, SerializedFace } from '../types/api';
import { inkColor, KNOWN_COLOR, OWN_COLOR } from './chipStyle';
import FaceTile from './FaceTile';

const COLS = { base: 2, sm: 4, lg: 6 } as const;
const FACE_SIZE = 96;

const countLabel = (n: number) => `${n} ${n === 1 ? 'photo' : 'photos'}`;

function TileButton({
  onClick,
  children,
  name,
  count,
  marker,
}: {
  onClick: () => void;
  children: ReactNode;
  name: string;
  count: number;
  marker?: { text: string; color: string };
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      aria-label={`${name}, ${countLabel(count)}${marker ? `, ${marker.text}` : ''}`}
      p="xs"
    >
      <Stack gap={4} align="center">
        {children}
        <Text size="sm" fw={500} ta="center" lineClamp={2}>
          {name}
        </Text>
        <Text size="xs" c="dimmed">
          {countLabel(count)}
        </Text>
        {marker && (
          <Text size="xs" style={{ color: marker.color }}>
            {marker.text}
          </Text>
        )}
      </Stack>
    </UnstyledButton>
  );
}

function Face({ face, color }: { face: SerializedFace | null; color: string }) {
  return (
    <Box
      style={{
        border: `3px solid ${inkColor(color)}`,
        borderRadius: '50%',
        padding: 2,
        width: FACE_SIZE + 10,
        height: FACE_SIZE + 10,
      }}
    >
      {face ? (
        // The tile's own text carries the name, so the crop stays nameless.
        <FaceTile face={{ ...face, personName: null }} size={FACE_SIZE} round />
      ) : (
        <Box
          style={{
            width: FACE_SIZE,
            height: FACE_SIZE,
            borderRadius: '50%',
            backgroundColor: 'var(--mantine-color-default-hover)',
          }}
        />
      )}
    </Box>
  );
}

/** Round face tiles: the album's own people first (blue ring), then known personalities (violet ring, "known" label). */
export function PeopleTiles({
  people,
  known,
  onPick,
}: {
  people: AlbumPersonTile[];
  known: AlbumKnownTile[];
  onPick: (filter: AlbumFilter) => void;
}) {
  return (
    <SimpleGrid cols={COLS}>
      {people.map((p) => (
        <TileButton
          key={`p:${p.id}`}
          name={p.name ?? 'Unnamed'}
          count={p.photoCount}
          onClick={() => onPick({ kind: 'people', value: p.id })}
        >
          <Face face={p.cover} color={OWN_COLOR} />
        </TileButton>
      ))}
      {known.map((k) => (
        <TileButton
          key={`k:${k.id}`}
          name={k.name}
          count={k.photoCount}
          marker={{ text: 'known', color: inkColor(KNOWN_COLOR) }}
          onClick={() => onPick({ kind: 'known', value: k.id })}
        >
          <Face face={k.cover} color={KNOWN_COLOR} />
        </TileButton>
      ))}
    </SimpleGrid>
  );
}

/** Square thumbnail tiles, one per species; the pick carries the scientific name. */
export function SpeciesTiles({
  species,
  onPick,
}: {
  species: AlbumSpeciesTile[];
  onPick: (filter: AlbumFilter) => void;
}) {
  return (
    <SimpleGrid cols={COLS}>
      {species.map((s) => (
        <TileButton
          key={s.scientific}
          name={s.common}
          count={s.photoCount}
          onClick={() => onPick({ kind: 'species', value: s.scientific })}
        >
          <Image
            src={workerApiClient.thumbnailUrl({ thumbnailUrl: s.thumbnailUrl })}
            alt={s.common}
            w="100%"
            style={{ aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 'var(--mantine-radius-md)' }}
          />
        </TileButton>
      ))}
    </SimpleGrid>
  );
}
