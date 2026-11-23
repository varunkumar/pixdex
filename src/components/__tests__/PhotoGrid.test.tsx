import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import PhotoGrid from '../PhotoGrid';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));

const photos = [
  makePhoto({ id: 'a', shortCaption: 'Alpha', album: 'Goa' }),
  makePhoto({
    id: 'b',
    shortCaption: 'Beta',
    album: 'Goa',
    width: 800,
    height: 1200,
  }),
  makePhoto({
    id: 'c',
    shortCaption: 'Gamma',
    album: 'Goa',
    width: 0,
    height: 0,
  }),
];

describe('PhotoGrid', () => {
  it('renders one tile per photo, each linking to its page', () => {
    renderWithProviders(<PhotoGrid photos={photos} />);
    for (const id of ['a', 'b', 'c']) {
      expect(document.querySelector(`a[href="/photos/${id}"]`)).not.toBeNull();
    }
  });

  it('calls actions per photo and forwards showAlbum and note', () => {
    const actions = vi.fn((p: { id: string }) => <button type="button">act-{p.id}</button>);
    renderWithProviders(<PhotoGrid photos={photos} actions={actions} note={(p) => `n-${p.id}`} showAlbum />);
    expect(actions).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'act-b' })).toBeInTheDocument();
    expect(screen.getAllByText('n-a')).toHaveLength(2);
    expect(screen.getAllByText('Goa').length).toBeGreaterThanOrEqual(3);
  });

  it('renders nothing broken for an empty list', () => {
    renderWithProviders(<PhotoGrid photos={[]} />);
    expect(document.querySelector('a')).toBeNull();
  });
});
