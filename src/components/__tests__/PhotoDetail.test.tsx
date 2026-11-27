import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/renderWithProviders';
import PhotoDetail from '../PhotoDetail';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPhoto: vi.fn(),
    getPhotoFaces: vi.fn(() => Promise.resolve([])),
    getMe: vi.fn(() => Promise.resolve({ email: 'owner@example.com', admin: false })),
    getPeople: vi.fn(() => Promise.resolve([])),
    thumbnailUrl: vi.fn(() => '/api/thumbnails/h1'),
  },
}));

const originals = vi.hoisted(() => ({
  getOriginalUrl: vi.fn(),
  getOriginalImageUrl: vi.fn(),
  getDriveUrl: vi.fn(),
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
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([]);
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
    expect(screen.getByRole('link', { name: 'View original' })).toHaveAttribute('href', '/api/originals/p1');
    expect(workerApiClient.getPhoto).toHaveBeenCalledWith('p1');
  });

  it('lists the species the model found, with scientific name and confidence', async () => {
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue({
      ...tiger,
      species: [
        { common: 'Jungle myna', scientific: 'Acridotheres fuscus', score: 0.999 },
        { common: 'Spotted Deer', scientific: 'Axis axis', score: 0.65 },
      ],
    });
    renderWithRouter(routes, ['/photos/p1']);

    expect(await screen.findByText('Species')).toBeInTheDocument();
    expect(screen.getByText('Jungle myna · Acridotheres fuscus · 100%')).toBeInTheDocument();
    expect(screen.getByText('Spotted Deer · Axis axis · 65%')).toBeInTheDocument();
  });

  it('shows no species section when there are none', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    await screen.findByText('A long and detailed description of a tiger on a rock.');
    expect(screen.queryByText('Species')).not.toBeInTheDocument();
  });

  it('shows the file name as its own field next to the short caption title', async () => {
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue({ ...tiger, shortCaption: 'Tiger on a rock' });
    renderWithRouter(routes, ['/photos/p1']);

    expect(await screen.findByRole('heading', { name: 'Tiger on a rock' })).toBeInTheDocument();
    expect(screen.getByText('File name')).toBeInTheDocument();
    expect(screen.getByText('DSC_8707-2.jpg')).toBeInTheDocument();
  });

  it('draws face boxes on the main photo only after the toggle is switched on', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      {
        id: 'f1',
        photoId: 'p1',
        thumbnailUrl: '/thumbnails/h1',
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        detScore: 0.99,
        personId: null,
        personName: null,
        status: 'unassigned',
        matchScore: null,
      },
    ]);
    renderWithRouter(routes, ['/photos/p1']);

    const toggle = await screen.findByRole('switch', { name: 'Show people on photo' });
    expect(screen.queryByTestId('face-box')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('face-box')).toHaveLength(1);
  });

  it('draws hidden face boxes only while their section is shown', async () => {
    const found = (id: string, ignored: boolean) => ({
      id,
      photoId: 'p1',
      thumbnailUrl: '/thumbnails/h1',
      bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      detScore: 0.99,
      personId: null,
      personName: null,
      status: 'unassigned' as const,
      matchScore: null,
      ignored,
    });
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue({ ...tiger, canEdit: true });
    const tiny = { ...found('t', false), detScore: 0.5 };
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([found('x', true), found('u', false), tiny]);
    renderWithRouter(routes, ['/photos/p1']);

    fireEvent.click(await screen.findByRole('switch', { name: 'Show people on photo' }));
    expect(screen.getAllByTestId('face-box')).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Ignored faces (1)' }));
    expect(screen.getAllByTestId('face-box')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Other faces (1)' }));
    expect(screen.getAllByTestId('face-box')).toHaveLength(3);
  });

  it('has no face toggle when the photo has no faces', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    await screen.findByText('NIKON Z 8');
    expect(screen.queryByRole('switch')).toBeNull();
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

  it('falls back to the thumbnail and a View original link when the original fails', async () => {
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    await screen.findByRole('dialog');
    FakeImage.instances.forEach((i) => i.onerror?.());
    expect(await screen.findByText(/original is unavailable/i)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: 'View original' })).toHaveAttribute('href', '/api/originals/p1');
  });

  it('shows an extra Open in Google Drive link for Drive photos', async () => {
    originals.getDriveUrl.mockReturnValue('https://drive.google.com/file/d/x/view');
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(
      makePhoto({ filename: 'drive.jpg', source: 'google_drive', driveFileId: 'x' })
    );
    renderWithRouter(routes, ['/photos/p1']);
    expect(await screen.findByRole('link', { name: 'Open in Google Drive' })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/x/view'
    );
    expect(screen.getByRole('link', { name: 'View original' })).toHaveAttribute('href', '/api/originals/p1');
  });

  it('does not prefetch when there is no original image URL and the lightbox still opens safely', async () => {
    originals.getOriginalImageUrl.mockReturnValue(null);
    originals.getOriginalUrl.mockReturnValue('https://drive.google.com/file/d/x/view');
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(
      makePhoto({ filename: 'drive.jpg', source: 'google_drive', driveFileId: 'x' })
    );
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    await screen.findByRole('dialog');
    expect(FakeImage.instances).toHaveLength(0);
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: 'View original' })).toHaveAttribute(
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

describe('PhotoDetail copy', () => {
  const copy = async (writeText: () => Promise<void>) => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(writeText) } });
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(makePhoto({ suggestedCaption: 'Golden coat.' }));
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([]);
    renderWithRouter(routes, ['/photos/p1']);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to clipboard' }));
  };

  it('says the caption was copied', async () => {
    await copy(() => Promise.resolve());
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('says when the caption could not be copied', async () => {
    await copy(() => Promise.reject(new Error('Clipboard blocked')));
    expect(await screen.findByText('Failed to copy')).toBeInTheDocument();
    expect(screen.getByText('Clipboard blocked')).toBeInTheDocument();
  });
});
