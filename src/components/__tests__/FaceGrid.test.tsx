import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { SerializedFace } from '../../types/api';
import FaceGrid, { faceItems } from '../FaceGrid';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`) },
}));

const box = (x: number) => ({ x, y: 0.2, w: 0.2, h: 0.2 });

const face = (id: string, photoId: string, overrides: Partial<SerializedFace> = {}): SerializedFace => ({
  id,
  photoId,
  thumbnailUrl: '/thumbnails/h1',
  bbox: box(0.1),
  detScore: 0.99,
  personId: 'pe1',
  personName: 'Asha',
  status: 'confirmed',
  matchScore: null,
  ...overrides,
});

const gridOf = (faces: SerializedFace[]) => faceItems(faces, [makePhoto({ id: 'p1' })], 'pe1');

describe('faceItems', () => {
  it('keeps confirmed and auto faces of the person, in photo order then left to right', () => {
    const items = faceItems(
      [
        face('b', 'p2', { status: 'auto' }),
        face('right', 'p1', { bbox: box(0.6) }),
        face('left', 'p1', { bbox: box(0.1) }),
        face('other', 'p1', { personId: 'pe2' }),
        face('open', 'p1', { status: 'unassigned' }),
        face('gone', 'p9'),
      ],
      [makePhoto({ id: 'p1' }), makePhoto({ id: 'p2' })],
      'pe1'
    );
    expect(items.map((i) => i.face.id)).toEqual(['left', 'right', 'b']);
  });

  it('gives two faces of one photo different names', () => {
    const items = faceItems(
      [face('a', 'p1'), face('b', 'p1', { bbox: box(0.6) }), face('c', 'p2')],
      [makePhoto({ id: 'p1' }), makePhoto({ id: 'p2' })],
      'pe1'
    );
    expect(items[0].label).toMatch(/, face 1$/);
    expect(items[1].label).toMatch(/, face 2$/);
    expect(items[2].label).not.toMatch(/face \d/);
  });
});

describe('FaceGrid', () => {
  it('shows the crop as a lazy picture in a link to the photo', () => {
    renderWithProviders(<FaceGrid items={gridOf([face('f1', 'p1', { cropUrl: '/faces/f1/crop' })])} />);
    const link = screen.getByRole('link', { name: /leopard/i });
    expect(link).toHaveAttribute('href', '/photos/p1');
    expect(link.querySelector('img')).toHaveAttribute('src', '/api/faces/f1/crop');
    expect(link.querySelector('img')).toHaveAttribute('loading', 'lazy');
  });

  it('cuts a face without a crop out of the thumbnail', () => {
    renderWithProviders(<FaceGrid items={gridOf([face('f1', 'p1', { bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } })])} />);
    const cut = screen.getByTestId('face-cut');
    expect(cut.style.backgroundImage).toContain('/api/thumbnails/h1');
    expect(cut.style.backgroundSize).toBe('200% 250%');
    expect(cut.style.backgroundPosition).toBe('20% 33.333%');
  });

  it('stays finite for a box as large as the photo', () => {
    renderWithProviders(<FaceGrid items={gridOf([face('f1', 'p1', { bbox: { x: 0, y: 0, w: 1, h: 1 } })])} />);
    expect(screen.getByTestId('face-cut').style.backgroundPosition).toBe('0% 0%');
  });

  it('puts badges, mark and actions in the photo tile places', () => {
    renderWithProviders(
      <FaceGrid
        items={gridOf([face('f1', 'p1')])}
        badges={() => <span>badge</span>}
        mark={() => <span>mark</span>}
        actions={() => <button>act</button>}
      />
    );
    expect(screen.getByText('badge').closest('.pdx-tile-badges')).not.toBeNull();
    expect(screen.getByText('mark').closest('.pdx-tile-line')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'act' }).closest('.pdx-tile-actions')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'act' }).closest('a')).toBeNull();
  });
});
