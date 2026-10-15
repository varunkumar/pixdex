import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/renderWithProviders';
import PhotoDetail from '../PhotoDetail';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getPhoto: vi.fn(), thumbnailUrl: vi.fn(() => '/api/thumbnails/h1') },
}));

const originals = vi.hoisted(() => ({
  getOriginalUrl: vi.fn(),
  getOriginalImageUrl: vi.fn(),
}));
vi.mock('../../services/originals', () => originals);

class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.instances.push(this);
  }
}

const routes = [
  { path: '/search', element: <p>search page</p> },
  { path: '/photos/:id', element: <PhotoDetail /> },
];

const tiger = makePhoto({
  filename: 'DSC_8707-2.jpg',
  dateTime: '2026-09-12T12:29:23.000Z',
  width: 2884,
  height: 4326,
  format: 'jpeg',
  fileSize: 9_703_582,
  subjects: ['tiger'],
  colors: ['orange'],
  patterns: ['stripes'],
  tags: ['big cat'],
  season: 'winter',
  environment: 'Dry deciduous forest.',
  album: 'Bandipur',
  description: 'A long and detailed description of a tiger on a rock.',
  suggestedCaption: 'Stripes for days.',
  suggestedHashtags: ['tiger'],
  cameraModel: 'NIKON Z 8',
  lensModel: 'VR 200-500mm f/5.6E',
  focalLength: 500,
  fNumber: 5.6,
  exposureTime: 0.004,
  iso: 2500,
  latitude: 11.67,
  longitude: 76.63,
  hasWatermark: true,
});

describe('PhotoDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
    originals.getOriginalUrl.mockReturnValue('/api/originals/p1');
    originals.getOriginalImageUrl.mockReturnValue('/api/originals/p1');
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(tiger);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the full description and every photo detail', async () => {
    renderWithRouter(routes, ['/photos/p1']);

    expect(await screen.findByText('A long and detailed description of a tiger on a rock.')).toBeInTheDocument();
    expect(screen.getByText('NIKON Z 8')).toBeInTheDocument();
    expect(screen.getByText('VR 200-500mm f/5.6E')).toBeInTheDocument();
    expect(screen.getByText('500mm · f/5.6 · 1/250s · ISO 2500')).toBeInTheDocument();
    expect(screen.getByText('2884 × 4326')).toBeInTheDocument();
    expect(screen.getByText('9.3 MB')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bandipur' })).toHaveAttribute('href', '/albums/Bandipur');
    expect(screen.getByRole('link', { name: /view on map/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps?q=11.67,76.63'
    );
    expect(screen.getByRole('link', { name: /view original/i })).toHaveAttribute('href', '/api/originals/p1');
    expect(workerApiClient.getPhoto).toHaveBeenCalledWith('p1');
  });

  it('shows the file name as its own field next to the short caption title', async () => {
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue({ ...tiger, shortCaption: 'Tiger on a rock' });
    renderWithRouter(routes, ['/photos/p1']);

    expect(await screen.findByRole('heading', { name: 'Tiger on a rock' })).toBeInTheDocument();
    expect(screen.getByText('File name')).toBeInTheDocument();
    expect(screen.getByText('DSC_8707-2.jpg')).toBeInTheDocument();
  });

  it('shows the watermark field only when it is known', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    expect(await screen.findByText('Watermark')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('hides the watermark field when unknown', async () => {
    vi.mocked(workerApiClient.getPhoto).mockResolvedValueOnce({ ...tiger, hasWatermark: null });
    renderWithRouter(routes, ['/photos/p1']);

    expect(await screen.findByText('A long and detailed description of a tiger on a rock.')).toBeInTheDocument();
    expect(screen.queryByText('Watermark')).not.toBeInTheDocument();
  });

  it('prefetches the original on load', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    await screen.findByRole('heading', { name: 'DSC_8707-2.jpg' });
    expect(FakeImage.instances.map((i) => i.src)).toContain('/api/originals/p1');
  });

  it('opens the lightbox on click and deep links it with ?lightbox=1', async () => {
    const { router } = renderWithRouter(routes, ['/photos/p1']);
    fireEvent.click(await screen.findByRole('button', { name: /open full-size photo/i }));
    await waitFor(() => expect(router.state.location.search).toBe('?lightbox=1'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opens straight into the lightbox from a deep link', async () => {
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('falls back to the thumbnail and an Open original link when the original fails', async () => {
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    await screen.findByRole('dialog');
    FakeImage.instances.forEach((i) => i.onerror?.());
    expect(await screen.findByText(/original is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', '/api/originals/p1');
  });

  it('does not prefetch for Drive photos and the lightbox still opens safely', async () => {
    originals.getOriginalImageUrl.mockReturnValue(null);
    originals.getOriginalUrl.mockReturnValue('https://drive.google.com/file/d/x/view');
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(
      makePhoto({ filename: 'drive.jpg', source: 'google_drive', driveFileId: 'x' })
    );
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    await screen.findByRole('dialog');
    expect(FakeImage.instances).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/x/view'
    );
  });

  it('closing a lightbox that was opened by clicking goes back in history', async () => {
    const { router } = renderWithRouter(routes, ['/photos/p1']);
    fireEvent.click(await screen.findByRole('button', { name: /open full-size photo/i }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('back link falls back to the album when there is no history', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    const back = await screen.findByRole('link', { name: /back to album/i });
    expect(back).toHaveAttribute('href', '/albums/Bandipur');
  });

  it('shows an error and a way back when the photo is missing', async () => {
    vi.mocked(workerApiClient.getPhoto).mockRejectedValue(new Error('Request to /photos/p1 failed: 404'));
    renderWithRouter(routes, ['/photos/p1']);
    expect(await screen.findByText('Request to /photos/p1 failed: 404')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to search/i })).toHaveAttribute('href', '/search');
  });

  it('after closing a deep-linked lightbox, Back still falls back to the album instead of leaving the app', async () => {
    // A browser history entry that is the first one in this tab.
    window.history.replaceState({ idx: 0 }, '');
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    const back = await screen.findByRole('link', { name: /back to album/i });
    expect(back).toHaveAttribute('href', '/albums/Bandipur');
    window.history.replaceState(null, '');
  });

  it('reached from an album page, offers a plain Back instead of Back to search', async () => {
    renderWithRouter(
      [{ path: '/albums/:name', element: <p>album page</p> }, ...routes],
      ['/albums/Bandipur', '/photos/p1']
    );
    expect(await screen.findByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /back to search/i })).not.toBeInTheDocument();
  });

  it('when the photo fails to load after in-app navigation, Back goes back instead of to Search', async () => {
    vi.mocked(workerApiClient.getPhoto).mockRejectedValue(new Error('Your session has expired.'));
    renderWithRouter(
      [{ path: '/albums/:name', element: <p>album page</p> }, ...routes],
      ['/albums/Bandipur', '/photos/p1']
    );
    expect(await screen.findByText('Your session has expired.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /back to search/i })).not.toBeInTheDocument();
  });
});
