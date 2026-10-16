import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { SerializedFace } from '../../types/api';
import FaceTile from '../FaceTile';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`) },
}));

const face: SerializedFace = {
  id: 'f1',
  photoId: 'p1',
  thumbnailUrl: '/thumbnails/h1',
  bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
  detScore: 0.99,
  personId: null,
  personName: null,
  status: 'unassigned',
  matchScore: null,
};

describe('FaceTile', () => {
  it('draws the face as a rounded square', () => {
    renderWithProviders(<FaceTile face={face} size={80} />);
    const tile = screen.getByTestId('face-tile');
    expect(tile.style.borderRadius).toBe('var(--mantine-radius-md)');
    expect(tile.style.width).toBe('80px');
    expect(tile.style.height).toBe('80px');
  });

  it('shows the sharp crop, filling the tile, when the face has one', () => {
    renderWithProviders(<FaceTile face={{ ...face, cropUrl: '/faces/f1/crop' }} size={80} />);
    const tile = screen.getByTestId('face-tile');
    expect(tile.style.backgroundImage).toContain('/faces/f1/crop');
    expect(tile.style.backgroundSize).toBe('cover');
  });
});
