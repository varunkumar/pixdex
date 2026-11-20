import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { theme } from '../../theme';
import type { AlbumKnownTile, AlbumPersonTile, AlbumSpeciesTile, SerializedFace } from '../../types/api';
import { PeopleTiles, SpeciesTiles } from '../AlbumTiles';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`) },
}));

const face: SerializedFace = {
  id: 'f1',
  photoId: 'ph1',
  thumbnailUrl: '/thumbnails/ph1',
  bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
  detScore: 0.9,
  personId: null,
  personName: null,
  status: 'unassigned',
  matchScore: null,
};
const person = (o: Partial<AlbumPersonTile> = {}): AlbumPersonTile => ({
  id: 'p1',
  name: 'Asha',
  canEdit: true,
  photoCount: 3,
  cover: face,
  ...o,
});
const known: AlbumKnownTile = { id: 'Q1', name: 'Some Star', photoCount: 1, cover: face };
const species: AlbumSpeciesTile = {
  scientific: 'Panthera pardus',
  common: 'Leopard',
  photoCount: 2,
  coverPhotoId: 'ph1',
  thumbnailUrl: '/thumbnails/ph1',
};
const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider theme={theme} env="test">
      {ui}
    </MantineProvider>
  );

describe('PeopleTiles', () => {
  it('shows own people first, then known with a known label, as buttons with counts', () => {
    wrap(<PeopleTiles people={[person()]} known={[known]} onPick={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Asha');
    expect(buttons[0]).toHaveTextContent('3 photos');
    expect(buttons[1]).toHaveTextContent('Some Star');
    expect(buttons[1]).toHaveTextContent('1 photo');
    expect(buttons[1]).toHaveTextContent('known');
    expect(buttons[0]).not.toHaveTextContent('known');
  });

  it('reports the picked filter', () => {
    const onPick = vi.fn();
    wrap(<PeopleTiles people={[person()]} known={[known]} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: /Asha/ }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: 'people', value: 'p1' });
    fireEvent.click(screen.getByRole('button', { name: /Some Star/ }));
    expect(onPick).toHaveBeenLastCalledWith({ kind: 'known', value: 'Q1' });
  });

  it('labels a nameless person Unnamed and tolerates a missing cover', () => {
    wrap(<PeopleTiles people={[person({ name: null, cover: null })]} known={[]} onPick={() => {}} />);
    expect(screen.getByRole('button', { name: /Unnamed/ })).toBeInTheDocument();
  });
});

describe('SpeciesTiles', () => {
  it('shows the common name, count and thumbnail and reports the scientific name', () => {
    const onPick = vi.fn();
    wrap(<SpeciesTiles species={[species]} onPick={onPick} />);
    const button = screen.getByRole('button', { name: /Leopard/ });
    expect(button).toHaveTextContent('2 photos');
    expect(screen.getByRole('img', { name: 'Leopard' })).toHaveAttribute('src', '/api/thumbnails/ph1');
    fireEvent.click(button);
    expect(onPick).toHaveBeenCalledWith({ kind: 'species', value: 'Panthera pardus' });
  });
});
