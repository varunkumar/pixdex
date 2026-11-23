import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('calls badges per photo', () => {
    renderWithProviders(<PhotoGrid photos={photos} badges={(p) => <span>badge-{p.id}</span>} />);
    expect(screen.getByText('badge-a')).toBeInTheDocument();
    expect(screen.getByText('badge-c')).toBeInTheDocument();
  });

  it('renders nothing broken for an empty list', () => {
    renderWithProviders(<PhotoGrid photos={[]} />);
    expect(document.querySelector('a')).toBeNull();
  });

  describe('tiles whose stored size disagrees with the thumbnail (a portrait photo recorded as landscape)', () => {
    beforeEach(() => window.localStorage.clear());

    const loadThumb = (tile: Element, width: number, height: number) => {
      const img = tile.querySelector('img') as HTMLImageElement;
      Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
      fireEvent.load(img);
    };
    const tiles = () => [...document.querySelectorAll('.pdx-tile')] as HTMLElement[];
    const landscape = makePhoto({ id: 'l', shortCaption: 'Rotated', width: 1600, height: 1067 });

    it('re-shapes the tile to the real thumbnail and remembers it for the next visit', () => {
      const { unmount } = renderWithProviders(<PhotoGrid photos={[landscape]} />);
      expect(Number.parseFloat(tiles()[0].style.aspectRatio)).toBeCloseTo(1600 / 1067);
      loadThumb(tiles()[0], 300, 400); // the thumbnail is upright portrait
      expect(Number.parseFloat(tiles()[0].style.aspectRatio)).toBeCloseTo(0.75);
      unmount();
      // A fresh grid starts from the remembered shape, no image load needed.
      renderWithProviders(<PhotoGrid photos={[landscape]} />);
      expect(Number.parseFloat(tiles()[0].style.aspectRatio)).toBeCloseTo(0.75);
    });

    it('re-balances the columns around the corrected shape', () => {
      const a = makePhoto({ id: 'a', width: 1600, height: 1067 });
      const b = makePhoto({ id: 'b', width: 1600, height: 1067 });
      renderWithProviders(<PhotoGrid photos={[a, b]} />);
      const grows = () =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="masonry-column"]')].map((c) =>
          Number.parseFloat(c.style.flexGrow)
        );
      expect(grows()[0]).toBeCloseTo(grows()[1]); // two equal landscape photos, two equal columns
      loadThumb(tiles()[0], 300, 400); // the first one is really portrait
      expect(Math.abs(grows()[0] - grows()[1])).toBeGreaterThan(0.1); // its column is now taller, so narrower
    });

    it('leaves a tile alone when the thumbnail matches the stored size', () => {
      renderWithProviders(<PhotoGrid photos={[landscape]} />);
      loadThumb(tiles()[0], 400, 267);
      expect(Number.parseFloat(tiles()[0].style.aspectRatio)).toBeCloseTo(1600 / 1067);
      expect(window.localStorage.getItem('pixdex.thumbRatios')).toBeNull();
    });

    it('ignores near-square photos, where the orientation is a coin toss', () => {
      const square = makePhoto({ id: 's', width: 1000, height: 1010 });
      renderWithProviders(<PhotoGrid photos={[square]} />);
      loadThumb(tiles()[0], 400, 395);
      expect(window.localStorage.getItem('pixdex.thumbRatios')).toBeNull();
    });
  });
});
