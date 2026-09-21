import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Search from '../Search';
import { workerApiClient } from '../../services/api/WorkerApiClient';

vi.mock('../../services/api/WorkerApiClient', async () => {
  const actual = await vi.importActual('../../services/api/WorkerApiClient');
  return {
    ...actual,
    workerApiClient: {
      search: vi.fn(),
      getAlbums: vi.fn(),
      thumbnailUrl: vi.fn((photo: { thumbnailUrl?: string }) => `https://example.workers.dev${photo.thumbnailUrl}`),
    },
  };
});

vi.mock('../../services/originals', () => ({
  getOriginalUrl: vi.fn(() => 'https://pixdex-originals.example.com/originals/p1?token=shh'),
  originalsConfig: {},
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ChakraProvider>
    </QueryClientProvider>
  );
}

describe('Search', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha']);
    vi.mocked(workerApiClient.search).mockResolvedValue([
      {
        id: 'p1',
        path: null,
        driveFileId: null,
        dateTime: null,
        width: null,
        height: null,
        format: null,
        fileSize: null,
        subjects: ['leopard'],
        colors: [],
        patterns: [],
        tags: ['leopard'],
        season: null,
        environment: null,
        album: 'Kanha',
        description: 'A leopard in a tree.',
        suggestedHashtags: [],
        instagramSuggested: null,
        thumbnailUrl: '/thumbnails/h1',
      },
    ]);
  });

  it('runs a search and renders the results', async () => {
    renderWithProviders(<Search />);

    fireEvent.change(screen.getByPlaceholderText('Search photos...'), {
      target: { value: 'big cat' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(workerApiClient.search).toHaveBeenCalledWith({ q: 'big cat', album: '' });
    });
    expect(await screen.findByText('A leopard in a tree.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /leopard in a tree/i })).toHaveAttribute(
      'src',
      'https://example.workers.dev/thumbnails/h1'
    );
  });

  it('shows a "View Original" link when getOriginalUrl resolves one', async () => {
    renderWithProviders(<Search />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    const link = await screen.findByRole('link', { name: /view original/i });
    expect(link).toHaveAttribute('href', 'https://pixdex-originals.example.com/originals/p1?token=shh');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
