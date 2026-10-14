import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import ListPagination from '../ListPagination';

const base = { page: 1, size: 10, total: 56, sizes: [10, 20, 50], onPage: vi.fn(), onSize: vi.fn() };

describe('ListPagination', () => {
  it('shows the visible range and total', () => {
    renderWithProviders(<ListPagination {...base} page={2} />);
    expect(screen.getByText('Showing 11-20 of 56')).toBeInTheDocument();
  });

  it('caps the range end at the total', () => {
    renderWithProviders(<ListPagination {...base} page={6} />);
    expect(screen.getByText('Showing 51-56 of 56')).toBeInTheDocument();
  });

  it('reports page changes', () => {
    const onPage = vi.fn();
    renderWithProviders(<ListPagination {...base} onPage={onPage} />);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it('renders nothing for an empty result', () => {
    renderWithProviders(<ListPagination {...base} total={0} />);
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1' })).not.toBeInTheDocument();
  });

  it('replaces the URL with the last page when page is out of range', () => {
    const onPage = vi.fn();
    renderWithProviders(<ListPagination {...base} page={999} onPage={onPage} />);
    expect(onPage).toHaveBeenCalledWith(6, true);
  });
});
