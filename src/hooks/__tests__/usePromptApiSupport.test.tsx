import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPromptApiStatus } from '../../services/aiSearch/promptApi';
import { usePromptApiSupport } from '../usePromptApiSupport';

vi.mock('../../services/aiSearch/promptApi', () => ({ getPromptApiStatus: vi.fn() }));

describe('usePromptApiSupport', () => {
  beforeEach(() => {
    vi.mocked(getPromptApiStatus).mockReset();
  });

  it('is checking first, then supported when the model is downloadable', async () => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('downloadable');
    const { result } = renderHook(() => usePromptApiSupport());
    expect(result.current).toBe('checking');
    await waitFor(() => expect(result.current).toBe('supported'));
    expect(getPromptApiStatus).toHaveBeenCalledTimes(1);
  });

  it('is unsupported when the API is unsupported', async () => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('unsupported');
    const { result } = renderHook(() => usePromptApiSupport());
    await waitFor(() => expect(result.current).toBe('unsupported'));
  });
});
