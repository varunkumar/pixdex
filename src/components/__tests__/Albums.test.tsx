import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Albums from '../Albums';
import { workerApiClient } from '../../services/api/WorkerApiClient';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getAlbums: vi.fn() },
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

describe('Albums', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha 2026', 'Kaziranga 2026']);
  });

  it('lists albums as links into Search', async () => {
    renderWithProviders(<Albums />);

    const link = await screen.findByRole('link', { name: 'Kanha 2026' });
    expect(link).toHaveAttribute('href', '/search?album=Kanha+2026');
  });
});
