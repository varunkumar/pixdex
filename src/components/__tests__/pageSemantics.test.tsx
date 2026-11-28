import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { loadHero } from '../../services/heroImage';
import { makeAlbum, makePhoto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/renderWithProviders';
import type { SerializedFace } from '../../types/api';
import AdminAccess from '../AdminAccess';
import AlbumPhotos from '../AlbumPhotos';
import Albums from '../Albums';
import DailySuggestion from '../DailySuggestion';
import Dashboard from '../Dashboard';
import People from '../People';
import PersonPage from '../PersonPage';
import PhotoDetail from '../PhotoDetail';
import ReviewAutoFaces from '../ReviewAutoFaces';
import ReviewQueue from '../ReviewQueue';
import Search from '../Search';
import Timeline from '../Timeline';

vi.mock('../../services/api/WorkerApiClient', () => {
  const names = [
    'getMe', 'getAlbumsPage', 'searchPage', 'getAlbums', 'getAlbumContents', 'getTimeline', 'getTimelineBuckets',
    'getPeople', 'getKnownPeople', 'getFaceGroups', 'getReviewQueue', 'getAutoFaces', 'getPersonFaces', 'getPhoto',
    'getPhotoFaces', 'getDailyPick', 'listAccessRequests', 'getInsights', 'getOnThisDay',
  ];
  return {
    workerApiClient: {
      ...Object.fromEntries(names.map((n) => [n, vi.fn()])),
      thumbnailUrl: () => '/api/thumbnails/h1',
    },
  };
});
vi.mock('../../services/heroImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/heroImage')>()),
  loadHero: vi.fn(),
}));
vi.mock('../../services/aiSearch/promptApi', () => ({
  getPromptApiStatus: vi.fn(async () => 'unsupported'),
  expandRequest: vi.fn(),
}));

const routes = [
  { path: '/', element: <Dashboard /> },
  { path: '/albums', element: <Albums /> },
  { path: '/albums/:name', element: <AlbumPhotos /> },
  { path: '/timeline', element: <Timeline /> },
  { path: '/search', element: <Search /> },
  { path: '/photos/:id', element: <PhotoDetail /> },
  { path: '/people', element: <People /> },
  { path: '/people/:id', element: <PersonPage /> },
  { path: '/people/:id/review', element: <ReviewAutoFaces /> },
  { path: '/review', element: <ReviewQueue /> },
  { path: '/daily', element: <DailySuggestion /> },
  { path: '/admin/access', element: <AdminAccess /> },
];

const face: SerializedFace = {
  id: 'f1',
  photoId: 'p1',
  thumbnailUrl: '/thumbnails/h1',
  bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
  detScore: 0.9,
  personId: 'pe1',
  personName: 'Asha',
  status: 'auto',
  matchScore: 0.6,
};
const photo = makePhoto({
  shortCaption: 'Leopard at dusk',
  album: 'Kabini',
  species: [],
  suggestedCaption: 'Dusk.',
});
const person = { id: 'pe1', name: 'Asha', faceCount: 1, photoCount: 1, canEdit: true, cover: null };

/** Heading levels in page order: exactly one h1, and none more than one step below the heading before it. */
const expectOutline = () => {
  const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName[1]));
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  levels.reduce((previous, level) => {
    expect(level).toBeLessThanOrEqual(previous + 1);
    return level;
  }, 0);
};

describe('page titles and headings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    document.title = '';
    const api = vi.mocked(workerApiClient);
    api.getMe.mockResolvedValue({ email: 'owner@example.com', admin: true });
    api.getAlbumsPage.mockResolvedValue({ albums: [makeAlbum()], total: 1 });
    api.searchPage.mockResolvedValue({ results: [photo], total: 1 });
    api.getAlbums.mockResolvedValue(['Kabini']);
    api.getAlbumContents.mockResolvedValue({ people: [], known: [], species: [] });
    api.getTimeline.mockResolvedValue({
      groups: [{ key: '2026-03', total: 1, shown: 1, photos: [photo] }],
      nextCursor: null,
    });
    api.getTimelineBuckets.mockResolvedValue({ buckets: [], undated: 0 });
    api.getPeople.mockResolvedValue([person]);
    api.getKnownPeople.mockResolvedValue([]);
    api.getFaceGroups.mockResolvedValue({
      groups: [{ faces: [{ ...face, personId: null, status: 'unassigned' }] }],
      scanned: 1,
      nextCursor: null,
    });
    api.getReviewQueue.mockResolvedValue([{ id: 'pe1', count: 1 }]);
    api.getAutoFaces.mockResolvedValue({ faces: [face], nextCursor: null });
    api.getPersonFaces.mockResolvedValue([face]);
    api.getPhoto.mockResolvedValue(photo);
    api.getPhotoFaces.mockResolvedValue([face]);
    api.getDailyPick.mockResolvedValue({ photo, reason: 'Sharp.', suggestedCaption: 'Dusk.', suggestedHashtags: [] });
    api.listAccessRequests.mockResolvedValue({ requests: [], pendingCount: 0, queueFull: false });
    vi.mocked(loadHero).mockResolvedValue(null);
    api.getInsights.mockResolvedValue({ day: '2026-11-28', facts: [{ id: 'top-weekday', data: { counts: [0, 0, 0, 100, 0, 0, 0], total: 100 } }] });
    api.getOnThisDay.mockResolvedValue({ date: '2026-11-28', years: [{ year: 2023, photos: [photo] }] });
  });

  it.each([
    ['/', 'Dashboard', 'Recently indexed'],
    ['/albums', 'Albums', 'Albums'],
    ['/albums/Kabini', 'Kabini', '3 photos'],
    ['/timeline', 'Timeline', 'March 2026'],
    ['/search', 'Search', 'Search'],
    ['/photos/p1', 'Leopard at dusk', 'People'],
    ['/people', 'People', 'Unnamed groups'],
    ['/people/pe1', 'Asha', 'Asha'],
    ['/people/pe1/review', 'Review Asha', 'Review auto matches: Asha'],
    ['/review', 'To review', '1 to review'],
    ['/daily', 'Daily pick', 'Why this photo?'],
    ['/admin/access', 'Access requests', 'No pending requests.'],
  ])('%s is titled "%s" and has one h1', async (path, title, ready) => {
    renderWithRouter(routes, [path]);
    await waitFor(() => expect(screen.getAllByText(new RegExp(ready.replace('?', '\\?'))).length).toBeGreaterThan(0));
    await waitFor(() => expect(document.title).toBe(`${title} | PixdeX`));
    await waitFor(expectOutline);
  });

  it('titles a photo by its file name, then "Photo"', async () => {
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(makePhoto({ filename: 'DSC_9.jpg' }));
    renderWithRouter(routes, ['/photos/p1']);
    await waitFor(() => expect(document.title).toBe('DSC_9.jpg | PixdeX'));
  });

  it.each([
    ['/people/nobody', 'This person was not found.'],
    ['/people/nobody/review', 'This person was not found.'],
  ])('%s still has a heading when there is nothing to show', async (path, text) => {
    renderWithRouter(routes, [path]);
    expect(await screen.findByRole('heading', { level: 1, name: text })).toBeInTheDocument();
  });

  it('tells a non-admin the page is not found', async () => {
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'u@example.com', admin: false });
    renderWithRouter(routes, ['/admin/access']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found.' })).toBeInTheDocument();
    expect(document.title).toBe('Page not found | PixdeX');
  });
});
