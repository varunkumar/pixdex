import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPromptApiStatus } from '../../services/aiSearch/promptApi';
import { renderWithRouter } from '../../test/renderWithProviders';
import AiSearch from '../AiSearch';

vi.mock('../../services/aiSearch/promptApi', () => ({ getPromptApiStatus: vi.fn() }));

const routes = [
  { path: '/', element: <div>home</div> },
  { path: '/ai-search', element: <AiSearch /> },
];

describe('AiSearch route guard', () => {
  beforeEach(() => {
    vi.mocked(getPromptApiStatus).mockReset();
  });

  it('redirects home when unsupported', async () => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('unsupported');
    const { router } = renderWithRouter(routes, ['/ai-search']);
    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('shows the heading when supported', async () => {
    vi.mocked(getPromptApiStatus).mockResolvedValue('available');
    const { router } = renderWithRouter(routes, ['/ai-search']);
    expect(await screen.findByRole('heading', { name: 'AI Search' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/ai-search');
  });

  it('shows a loader while checking', async () => {
    vi.mocked(getPromptApiStatus).mockReturnValue(new Promise(() => {}));
    const { router } = renderWithRouter(routes, ['/ai-search']);
    await waitFor(() => expect(document.querySelector('.mantine-Loader-root')).not.toBeNull());
    expect(router.state.location.pathname).toBe('/ai-search');
  });
});
