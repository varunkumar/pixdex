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

  it('tells screen readers who an album is shared with and by, without needing hover', () => {
    const { unmount } = renderWithProviders(
      <AlbumCard album={makeAlbum({ sharedWith: ['a@example.com', 'b@example.com'] })} />
    );
    expect(screen.getByRole('link', { name: /kabini/i })).toHaveTextContent('Shared with a@example.com, b@example.com');
    unmount();
    renderWithProviders(<AlbumCard album={makeAlbum({ role: 'viewer', ownerEmail: 'owner@example.com' })} />);
    expect(screen.getByRole('link', { name: /kabini/i })).toHaveTextContent('Shared by owner@example.com');
  });

  it('does not repeat the album name through the cover image alt', () => {
    renderWithProviders(<AlbumCard album={makeAlbum()} />);
    expect(document.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.getByRole('link', { name: 'Kabini 3 photos' })).toBeInTheDocument();
  });

  it('shows a placeholder when there is no cover', () => {
    renderWithProviders(<AlbumCard album={makeAlbum({ coverThumbnailUrl: null })} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /kabini/i })).toBeInTheDocument();
  });
});
