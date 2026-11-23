import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAlbum } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import AlbumCard from '../AlbumCard';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
    putAlbumShares: vi.fn(),
  },
}));

describe('AlbumCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the name and count inside the album link', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ name: 'Goa 2024', photoCount: 142 })} />);
    const link = screen.getByRole('link', { name: /goa 2024/i });
    expect(link).toHaveAttribute('href', '/albums/Goa%202024');
    expect(link).toHaveTextContent('142 photos');
  });

  it('shows the sharee avatars and a Share button (outside the link) to the owner', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ sharedWith: ['a@example.com', 'b@example.com'] })} />);
    expect(screen.getByLabelText('a@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('b@example.com')).toBeInTheDocument();
    const share = screen.getByRole('button', { name: 'Share Kabini' });
    expect(screen.getByRole('link', { name: /kabini/i }).contains(share)).toBe(false);
    fireEvent.click(share);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows no avatars for an owner album that is not shared, but still the Share button', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ sharedWith: [] })} />);
    expect(screen.queryByLabelText(/@example\.com/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share Kabini' })).toBeInTheDocument();
  });

  it('shows Shared with you and the owner avatar, and no Share button, on a viewer album', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ role: 'viewer', ownerEmail: 'owner@example.com' })} />);
    expect(screen.getByText('Shared with you')).toBeInTheDocument();
    expect(screen.getByLabelText('owner@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^share/i })).not.toBeInTheDocument();
  });

  it('names the album, count and sharing in the link name, since the text is hover-only on a mouse', () => {
    const { unmount } = renderWithProviders(
      <AlbumCard album={makeAlbum({ photoCount: 12, sharedWith: ['a@example.com', 'b@example.com'] })} />
    );
    expect(screen.getByRole('link', { name: 'Kabini, 12 photos, shared with a@example.com, b@example.com' })).toBeInTheDocument();
    unmount();
    renderWithProviders(<AlbumCard album={makeAlbum({ photoCount: 1, role: 'viewer', ownerEmail: 'owner@example.com' })} />);
    expect(screen.getByRole('link', { name: 'Kabini, 1 photo, shared by owner@example.com' })).toBeInTheDocument();
  });

  it('always shows the name below the cover, and the count and date over it on hover', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ name: 'Goa 2024', photoCount: 142, latestDate: '2024-03-12T10:00:00Z' })} />);
    const overlay = document.querySelector('.pdx-album-text') as HTMLElement;
    const cap = document.querySelector('.pdx-album-cap') as HTMLElement;
    expect(cap.querySelector('.pdx-album-name')).toHaveTextContent('Goa 2024');
    expect(overlay).toHaveTextContent('142 photos');
    expect(overlay).not.toHaveTextContent('Goa 2024'); // the name is not repeated over the image
    // On touch the count and date join the name line, since there is no hover.
    expect(cap.querySelector('.pdx-album-cap-meta')).toHaveTextContent('142 photos');
  });

  it('reveals the sharing avatars and the Shared with you chip together with the hover details', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ role: 'viewer', ownerEmail: 'owner@example.com' })} />);
    expect(screen.getByText('Shared with you').closest('.pdx-reveal')).not.toBeNull();
    expect(screen.getByLabelText('owner@example.com').closest('.pdx-reveal')).not.toBeNull();
  });

  it('does not repeat the album name through the cover image alt', () => {
    renderWithProviders(<AlbumCard album={makeAlbum()} />);
    expect(document.querySelector('img')).toHaveAttribute('alt', '');
  });

  it('shows a placeholder when there is no cover', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ coverThumbnailUrl: null })} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /kabini/i })).toBeInTheDocument();
  });
});
