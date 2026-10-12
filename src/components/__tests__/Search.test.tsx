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
  getOriginalUrl: vi.fn(() => '/api/originals/p1'),
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
        cameraModel: 'NIKON Z 8',
        lensModel: 'VR 200-500mm f/5.6E',
        focalLength: 500,
        fNumber: 5.6,
        exposureTime: 0.004,
        iso: 2500,
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

  it('shows only the camera body in listings; lens and exposure live on the detail page', async () => {
    renderWithProviders(<Search />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText('NIKON Z 8')).toBeInTheDocument();
    expect(screen.queryByText(/200-500mm/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ISO 2500/)).not.toBeInTheDocument();
  });

  it('links each result to its detail page and trims long descriptions', async () => {
    const long =
      'A leopard rests on a branch. ' + 'It watches the forest floor below with patient attention. '.repeat(6);
    vi.mocked(workerApiClient.search).mockResolvedValue([
      { ...(await vi.mocked(workerApiClient.search)({})).at(0)!, description: long, tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    ]);
    renderWithProviders(<Search />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText('A leopard rests on a branch.')).toBeInTheDocument();
    expect(screen.queryByText(/patient attention/)).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.queryByText('g')).not.toBeInTheDocument();
    const detailLinks = screen.getAllByRole('link').filter((l) => l.getAttribute('href') === '/photos/p1');
    expect(detailLinks.length).toBeGreaterThan(0);
  });

  it('shows a "View Original" link when getOriginalUrl resolves one', async () => {
    renderWithProviders(<Search />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    const link = await screen.findByRole('link', { name: /view original/i });
    expect(link).toHaveAttribute('href', '/api/originals/p1');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
