import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import PhotoCard from '../PhotoCard';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `https://example.workers.dev${p.thumbnailUrl}`),
  },
}));

vi.mock('../../services/originals', () => ({
  getOriginalUrl: vi.fn(() => '/api/originals/p1'),
}));

describe('PhotoCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the thumbnail and description', () => {
    renderWithProviders(<PhotoCard photo={makePhoto()} />);
    expect(screen.getByText('A leopard in a tree.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /leopard in a tree/i })).toHaveAttribute(
      'src',
      'https://example.workers.dev/thumbnails/h1'
    );
  });

  it('shows only the camera body in listings', () => {
    renderWithProviders(
      <PhotoCard photo={makePhoto({ cameraModel: 'NIKON Z 8', lensModel: 'VR 200-500mm f/5.6E', iso: 2500 })} />
    );
    expect(screen.getByText('NIKON Z 8')).toBeInTheDocument();
    expect(screen.queryByText(/200-500mm/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ISO 2500/)).not.toBeInTheDocument();
  });

  it('links to the detail page, trims long descriptions and caps tags', () => {
    const long = 'A leopard rests on a branch. ' + 'It watches the forest floor below with patient attention. '.repeat(6);
    renderWithProviders(
      <PhotoCard photo={makePhoto({ description: long, tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })} />
    );
    expect(screen.getByText('A leopard rests on a branch.')).toBeInTheDocument();
    expect(screen.queryByText(/patient attention/)).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.queryByText('g')).not.toBeInTheDocument();
    const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href') === '/photos/p1');
    expect(links.length).toBeGreaterThan(0);
  });

  it('shows a View Original link opening in a new tab', () => {
    renderWithProviders(<PhotoCard photo={makePhoto()} />);
    const link = screen.getByRole('link', { name: /view original/i });
    expect(link).toHaveAttribute('href', '/api/originals/p1');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
