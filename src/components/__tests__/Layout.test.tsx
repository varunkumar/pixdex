import { useQueryClient } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPromptApiStatus } from '../../services/aiSearch/promptApi';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { matchQueueFor } from '../../services/matchQueue';
import { renderWithProviders } from '../../test/renderWithProviders';
import Layout from '../Layout';

vi.mock('../../services/aiSearch/promptApi', () => ({ getPromptApiStatus: vi.fn() }));
vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getMe: vi.fn(), matchPersonAll: vi.fn() },
}));

describe('Layout', () => {
  beforeEach(() => {
    vi.mocked(getPromptApiStatus).mockReset();
    vi.mocked(getPromptApiStatus).mockResolvedValue('unsupported');
    vi.mocked(workerApiClient.getMe).mockReset();
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'u@example.com', admin: false });
  });

  it('shows the PixdeX brand linking home', () => {
    renderWithProviders(<Layout />);
    const brand = screen.getAllByRole('link', { name: 'PixdeX' })[0];
    expect(brand).toHaveAttribute('href', '/');
  });

  it('starts with a skip link that moves focus to the main area without changing the address', () => {
    renderWithProviders(<Layout />);
    const skip = screen.getAllByRole('link')[0];
    expect(skip).toHaveAccessibleName('Skip to main content');
    // fireEvent returns false when the default (a hash navigation) was prevented.
    expect(fireEvent.click(skip)).toBe(false);
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('links to every section', () => {
    renderWithProviders(<Layout />);
    const hrefFor = (name: string) =>
      screen.getAllByRole('link', { name }).map((l) => l.getAttribute('href'));
    expect(hrefFor('Dashboard')).toContain('/');
    expect(hrefFor('Albums')).toContain('/albums');
    expect(hrefFor('Timeline')).toContain('/timeline');
    expect(hrefFor('Search')).toContain('/search');
    expect(hrefFor('People')).toContain('/people');
    expect(hrefFor('Daily pick')).toContain('/daily');
  });

  it('offers log out and a burger for narrow screens', () => {
    renderWithProviders(<Layout />);
    expect(screen.getAllByRole('link', { name: /log out/i })[0]).toHaveAttribute(
      'href',
      '/cdn-cgi/access/logout'
    );
    expect(screen.getByRole('button', { name: /toggle navigation/i })).toBeInTheDocument();
  });

  it('shows background matching progress on every page', async () => {
    vi.mocked(workerApiClient.matchPersonAll).mockReturnValue(new Promise(() => {}));
    const Start = () => {
      const client = useQueryClient();
      useEffect(() => matchQueueFor(client).enqueue('a'), [client]);
      return null;
    };
    renderWithProviders(
      <>
        <Layout />
        <Start />
      </>
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Looking for more matches');
  });

  it('has a colour scheme toggle', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByRole('button', { name: /toggle colour scheme/i })).toBeInTheDocument();
  });

  it.each(['unsupported', 'available'] as const)('has no AI Search link when the Prompt API is %s', async (status) => {
    vi.mocked(getPromptApiStatus).mockResolvedValue(status);
    renderWithProviders(<Layout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('link', { name: 'AI Search' })).toBeNull();
    expect(screen.queryByText('AI Search')).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Search' }).length).toBeGreaterThanOrEqual(1);
  });

  it('hides the Access link for a non-admin', async () => {
    renderWithProviders(<Layout />);
    await screen.findByRole('button', { name: /account menu/i });
    expect(screen.queryByRole('link', { name: 'Access' })).toBeNull();
  });

  it('shows the Access link in the header and the drawer for an admin', async () => {
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'a@example.com', admin: true });
    renderWithProviders(<Layout />);
    const links = await screen.findAllByRole('link', { name: 'Access' });
    expect(links).toHaveLength(2);
    for (const l of links) expect(l).toHaveAttribute('href', '/admin/access');
  });
});
