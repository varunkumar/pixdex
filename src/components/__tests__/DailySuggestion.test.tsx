import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DailySuggestion from '../DailySuggestion';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { SerializedPhoto } from '../../types/api';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getDailyPick: vi.fn(), thumbnailUrl: vi.fn(() => 'https://example.workers.dev/thumbnails/h1') },
}));

vi.mock('../../services/originals', () => ({
  getOriginalUrl: vi.fn(() => '/api/originals/p1'),
  getOriginalImageUrl: vi.fn(() => '/api/originals/p1'),
}));

describe('DailySuggestion', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getDailyPick).mockResolvedValue({
      photo: {
        id: 'p1',
        canEdit: true,
        path: null,
        driveFileId: null,
        dateTime: null,
        width: null,
        height: null,
        format: null,
        fileSize: null,
        subjects: [],
        colors: [],
        patterns: [],
        tags: [],
        season: null,
        environment: null,
        album: null,
        suggestedHashtags: [],
        instagramSuggested: null,
        thumbnailUrl: '/thumbnails/h1',
      } satisfies SerializedPhoto,
      reason: 'It features a leopard in a forest setting.',
      suggestedCaption: 'Golden hour, golden coat.',
      suggestedHashtags: ['leopard', 'wildlife'],
    });
  });

  it('labels the page in sentence case', async () => {
    renderWithProviders(<DailySuggestion />);
    await screen.findByText('Golden hour, golden coat.');
    for (const text of ["Today's Instagram pick", 'Suggested caption', 'Suggested hashtags', 'Copy to clipboard']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('renders the daily pick with its pre-generated caption and hashtags', async () => {
    renderWithProviders(<DailySuggestion />);

    expect(await screen.findByText('Golden hour, golden coat.')).toBeInTheDocument();
    expect(screen.getByText('#leopard')).toBeInTheDocument();
    expect(screen.getByText('It features a leopard in a forest setting.')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.workers.dev/thumbnails/h1');
  });

  it('shows a "View original" link when getOriginalUrl resolves one', async () => {
    renderWithProviders(<DailySuggestion />);

    const link = await screen.findByRole('link', { name: 'View original' });
    expect(link).toHaveAttribute('href', '/api/originals/p1');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
