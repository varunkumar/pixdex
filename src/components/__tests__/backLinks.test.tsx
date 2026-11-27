import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makeAlbum, makePhoto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/renderWithProviders';
import AlbumPhotos from '../AlbumPhotos';
import Albums from '../Albums';
import PhotoDetail from '../PhotoDetail';
import People from '../People';
import PersonPage from '../PersonPage';
import ReviewAutoFaces from '../ReviewAutoFaces';
import ReviewQueue from '../ReviewQueue';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getMe: vi.fn(),
    getPeople: vi.fn(),
    getFaceGroups: vi.fn(),
    getReviewQueue: vi.fn(),
    getAutoFaces: vi.fn(),
    searchPage: vi.fn(),
    getAlbumsPage: vi.fn(),
    getAlbumContents: vi.fn(),
    getPhoto: vi.fn(),
    getPhotoFaces: vi.fn(),
    getPersonFaces: vi.fn(),
    thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`),
  },
}));

const routes = [
  { path: '/people', element: <People /> },
  { path: '/review', element: <ReviewQueue /> },
  { path: '/people/:id', element: <PersonPage /> },
  { path: '/people/:id/review', element: <ReviewAutoFaces /> },
  { path: '/albums', element: <Albums /> },
  { path: '/albums/:name', element: <AlbumPhotos /> },
  { path: '/photos/:id', element: <PhotoDetail /> },
];
const link = (name: string) => screen.findByRole('link', { name });

describe('in-page back links', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'owner@example.com', admin: false });
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, canEdit: true, cover: null },
    ]);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({ groups: [], scanned: 0, nextCursor: null });
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([{ id: 'pe1', count: 2 }]);
    vi.mocked(workerApiClient.getAutoFaces).mockResolvedValue({ faces: [], nextCursor: null });
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
  });

  it('return to the people list and the person page as they were left', async () => {
    const { router } = renderWithRouter(routes, ['/people?sort=count']);
    fireEvent.click(await link('2 matches to review'));
    expect(await link('← All people')).toHaveAttribute('href', '/people?sort=count');

    await router.navigate('/people/pe1?sort=rating');
    expect(await link('← All people')).toHaveAttribute('href', '/people?sort=count');
    fireEvent.click(await link('Review auto matches'));
    expect(await link('← Asha')).toHaveAttribute('href', '/people/pe1?sort=rating');
    expect(await link('← To review')).toHaveAttribute('href', '/review');
  });

  it('point at the plain pages when they have not been visited', async () => {
    renderWithRouter(routes, ['/people/pe1/review']);
    expect(await link('← Asha')).toHaveAttribute('href', '/people/pe1');
  });

  it('names an unnamed person on the review grid link', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: null, faceCount: 3, photoCount: 1, canEdit: true, cover: null },
    ]);
    renderWithRouter(routes, ['/people/pe1/review']);
    expect(await link('← Unnamed person')).toHaveAttribute('href', '/people/pe1');
  });

  it('returns to the albums list as it was left, even after going through a photo', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({ albums: [makeAlbum()], total: 30 });
    vi.mocked(workerApiClient.getAlbumContents).mockResolvedValue({ people: [], known: [], species: [] });
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(makePhoto({ album: 'Kabini' }));
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([]);
    const { router } = renderWithRouter(routes, ['/albums?sort=name&page=2']);
    await screen.findByRole('link', { name: /Kabini/ });
    await router.navigate('/albums/Kabini?sort=rating');
    await link('← All albums');
    await router.navigate('/photos/p1');
    fireEvent.click(await link('Kabini')); // the photo's album link carries no state
    await waitFor(() => expect(router.state.location.pathname).toBe('/albums/Kabini'));
    expect(await link('← All albums')).toHaveAttribute('href', '/albums?sort=name&page=2');
  });

  it('offers the album of a deep-linked photo, whatever its name', async () => {
    const album = "Tom & Jerry's 100% #1?";
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(makePhoto({ album }));
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([]);
    renderWithRouter(routes, ['/photos/p1']);
    const back = await link('← Back to album');
    expect(back).toHaveAttribute('href', `/albums/${encodeURIComponent(album)}`);
    expect(back).toHaveClass('pdx-target');
  });
});
