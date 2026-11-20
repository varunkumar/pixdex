import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import AlbumFilterChip from '../AlbumFilterChip';

describe('AlbumFilterChip', () => {
  it('clears through an accessible button', () => {
    const onClear = vi.fn();
    renderWithProviders(<AlbumFilterChip label="Asha" kind="people" onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onClear).toHaveBeenCalled();
    expect(screen.queryByText('known')).toBeNull();
  });
  it('marks known with text', () => {
    renderWithProviders(<AlbumFilterChip label="Q" kind="known" onClear={() => {}} />);
    expect(screen.getByText('known')).toBeTruthy();
  });
  it('shows the view-all link when href is given', () => {
    renderWithProviders(
      <AlbumFilterChip label="Elephant" kind="species" onClear={() => {}} href="/search?species=x" />
    );
    expect(screen.getByRole('link', { name: 'View all photos of Elephant' }).getAttribute('href')).toBe(
      '/search?species=x'
    );
  });
});
