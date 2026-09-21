import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DailySuggestion from '../DailySuggestion';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import type { SerializedPhoto } from '../../types/api';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getDailyPick: vi.fn(), thumbnailUrl: vi.fn(() => 'https://example.workers.dev/thumbnails/h1') },
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider>{ui}</ChakraProvider>
    </QueryClientProvider>
  );
}

describe('DailySuggestion', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getDailyPick).mockResolvedValue({
      photo: {
        id: 'p1',
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

  it('renders the daily pick with its pre-generated caption and hashtags', async () => {
    renderWithProviders(<DailySuggestion />);

    expect(await screen.findByText('Golden hour, golden coat.')).toBeInTheDocument();
    expect(screen.getByText('#leopard')).toBeInTheDocument();
    expect(screen.getByText('It features a leopard in a forest setting.')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.workers.dev/thumbnails/h1');
  });
});
