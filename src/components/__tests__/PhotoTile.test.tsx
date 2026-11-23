import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPhotoDate } from '../../services/exif';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import PhotoTile from '../PhotoTile';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `https://example.workers.dev${p.thumbnailUrl}`),
  },
}));

const DATE = '2024-03-12T10:00:00Z';
const dateText = formatPhotoDate(DATE)!;

describe('PhotoTile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a lazy thumbnail linking to the detail page', () => {
    renderWithProviders(<PhotoTile photo={makePhoto({ width: 1600, height: 1067 })} />);
    const img = screen.getByRole('img', { name: /leopard in a tree/i });
    expect(img).toHaveAttribute('src', 'https://example.workers.dev/thumbnails/h1');
    expect(img).toHaveAttribute('loading', 'lazy');
    const link = screen.getByRole('link', { name: /leopard in a tree/i });
    expect(link).toHaveAttribute('href', '/photos/p1');
  });

  it('keeps the caption and date in the DOM without hover (overlay and caption line)', () => {
    renderWithProviders(<PhotoTile photo={makePhoto({ shortCaption: 'Leopard at rest', dateTime: DATE })} />);
    expect(screen.getAllByText('Leopard at rest')).toHaveLength(2);
    expect(screen.getAllByText(new RegExp(dateText))).toHaveLength(2);
  });

  it('leaves description, camera and View Original off the tile', () => {
    renderWithProviders(
      <PhotoTile
        photo={makePhoto({
          shortCaption: 'Leopard',
          description: 'Long words here.',
          cameraModel: 'NIKON Z 8',
        })}
      />
    );
    expect(screen.queryByText('Long words here.')).not.toBeInTheDocument();
    expect(screen.queryByText('NIKON Z 8')).not.toBeInTheDocument();
    expect(screen.queryByText(/view original/i)).not.toBeInTheDocument();
  });

  it('shows at most 3 tags in the overlay', () => {
    renderWithProviders(<PhotoTile photo={makePhoto({ shortCaption: 'x', tags: ['a', 'b', 'c', 'd'] })} />);
    expect(screen.getByText('#a #b #c')).toBeInTheDocument();
    expect(screen.queryByText(/#d/)).not.toBeInTheDocument();
  });

  it('shows the album name instead of the date on the caption line when showAlbum is set', () => {
    renderWithProviders(
      <PhotoTile
        photo={makePhoto({
          shortCaption: 'Leopard',
          album: 'Goa 2024',
          dateTime: DATE,
        })}
        showAlbum
      />
    );
    // album chip in the overlay + album on the caption line
    expect(screen.getAllByText('Goa 2024')).toHaveLength(2);
    const cap = document.querySelector('.pdx-tile-cap')!;
    expect(cap.textContent).not.toContain(dateText);
  });

  it('shows a note in the overlay and on the caption line', () => {
    renderWithProviders(<PhotoTile photo={makePhoto({ shortCaption: 'Leopard' })} note="matched: cat · Rating: 4.2" />);
    expect(screen.getAllByText(/matched: cat/)).toHaveLength(2);
  });

  it('renders actions outside the link', () => {
    renderWithProviders(<PhotoTile photo={makePhoto()} actions={<button type="button">Do it</button>} />);
    const link = screen.getByRole('link', { name: /leopard in a tree/i });
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
    expect(link.contains(screen.getByRole('button', { name: 'Do it' }))).toBe(false);
  });
});
