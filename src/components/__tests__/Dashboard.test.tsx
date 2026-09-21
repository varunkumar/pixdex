import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../Dashboard';
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

describe('Dashboard', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha', 'Kaziranga']);
  });

  it('shows the album count and links to Search/Albums/Daily Pick, with no indexing controls', async () => {
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('2')).toBeInTheDocument(); // album count
    expect(screen.getByRole('link', { name: /search/i })).toHaveAttribute('href', '/search');
    expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '/albums');
    expect(screen.getByRole('link', { name: /daily pick/i })).toHaveAttribute('href', '/daily');
    expect(screen.queryByRole('button', { name: /index photos/i })).not.toBeInTheDocument();
  });
});
