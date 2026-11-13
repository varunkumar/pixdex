import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPromptApiStatus } from '../../services/aiSearch/promptApi';
import { renderWithProviders } from '../../test/renderWithProviders';
import Layout from '../Layout';

vi.mock('../../services/aiSearch/promptApi', () => ({ getPromptApiStatus: vi.fn() }));

describe('Layout', () => {
  beforeEach(() => {
    vi.mocked(getPromptApiStatus).mockReset();
    vi.mocked(getPromptApiStatus).mockResolvedValue('unsupported');
  });

  it('shows the PixdeX brand linking home', () => {
    renderWithProviders(<Layout />);
    const brand = screen.getAllByRole('link', { name: 'PixdeX' })[0];
    expect(brand).toHaveAttribute('href', '/');
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
    expect(hrefFor('Daily Pick')).toContain('/daily');
  });

  it('offers log out and a burger for narrow screens', () => {
    renderWithProviders(<Layout />);
    expect(screen.getAllByRole('link', { name: /log out/i })[0]).toHaveAttribute(
      'href',
      '/cdn-cgi/access/logout'
    );
    expect(screen.getByRole('button', { name: /toggle navigation/i })).toBeInTheDocument();
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
});
