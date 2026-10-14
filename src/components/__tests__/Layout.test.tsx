import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import Layout from '../Layout';

describe('Layout', () => {
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
    expect(hrefFor('Search')).toContain('/search');
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
});
