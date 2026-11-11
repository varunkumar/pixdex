import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { useMe } from '../useMe';

vi.mock('../../services/api/WorkerApiClient', () => ({ workerApiClient: { getMe: vi.fn() } }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe('useMe', () => {
  beforeEach(() => vi.resetAllMocks());

  it('has no email while loading, then the resolved one', async () => {
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'o@example.com' });
    const { result } = renderHook(() => useMe(), { wrapper });
    expect(result.current).toEqual({ email: null, loading: true });
    await waitFor(() => expect(result.current.email).toBe('o@example.com'));
    expect(result.current).toEqual({ email: 'o@example.com', loading: false });
  });

  it('has no email when the request fails', async () => {
    vi.mocked(workerApiClient.getMe).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useMe(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.email).toBeNull();
  });
});
