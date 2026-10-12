import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PhotoDetail from '../PhotoDetail';
import { workerApiClient } from '../../services/api/WorkerApiClient';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getPhoto: vi.fn(), thumbnailUrl: vi.fn(() => '/api/thumbnails/h1') },
}));

vi.mock('../../services/originals', () => ({
  getOriginalUrl: vi.fn(() => '/api/originals/p1'),
}));

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChakraProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/photos/:id" element={<PhotoDetail />} />
          </Routes>
        </MemoryRouter>
      </ChakraProvider>
    </QueryClientProvider>
  );
}

describe('PhotoDetail', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue({
      id: 'p1',
      filename: 'DSC_8707-2.jpg',
      path: null,
      driveFileId: null,
      dateTime: '2026-09-12T12:29:23.000Z',
      width: 2884,
      height: 4326,
      format: 'jpeg',
      fileSize: 9_703_582,
      subjects: ['tiger'],
      colors: ['orange'],
      patterns: ['stripes'],
      tags: ['big cat'],
      season: 'winter',
      environment: 'Dry deciduous forest.',
      album: 'Bandipur',
      description: 'A long and detailed description of a tiger on a rock.',
      suggestedCaption: 'Stripes for days.',
      suggestedHashtags: ['tiger'],
      instagramSuggested: null,
      cameraModel: 'NIKON Z 8',
      lensModel: 'VR 200-500mm f/5.6E',
      focalLength: 500,
      fNumber: 5.6,
      exposureTime: 0.004,
      iso: 2500,
      latitude: 11.67,
      longitude: 76.63,
    });
  });

  it('shows the full description and every photo detail', async () => {
    renderAt('/photos/p1');

    expect(await screen.findByText('A long and detailed description of a tiger on a rock.')).toBeInTheDocument();
    expect(screen.getByText('NIKON Z 8')).toBeInTheDocument();
    expect(screen.getByText('VR 200-500mm f/5.6E')).toBeInTheDocument();
    expect(screen.getByText('500mm · f/5.6 · 1/250s · ISO 2500')).toBeInTheDocument();
    expect(screen.getByText('2884 × 4326')).toBeInTheDocument();
    expect(screen.getByText('9.3 MB')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bandipur' })).toHaveAttribute('href', '/search?album=Bandipur');
    expect(screen.getByRole('link', { name: /view on map/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps?q=11.67,76.63'
    );
    expect(screen.getByRole('link', { name: /view original/i })).toHaveAttribute('href', '/api/originals/p1');
    expect(workerApiClient.getPhoto).toHaveBeenCalledWith('p1');
  });

  it('shows an error with a way back when the photo cannot be loaded', async () => {
    vi.mocked(workerApiClient.getPhoto).mockRejectedValueOnce(new Error('Request to /photos/x failed: 404'));
    renderAt('/photos/x');

    expect(await screen.findByText(/failed: 404/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to search/i })).toHaveAttribute('href', '/search');
  });
});
