import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithRouter } from '../../test/renderWithProviders';
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
    thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`),
  },
}));

const routes = [
  { path: '/people', element: <People /> },
  { path: '/review', element: <ReviewQueue /> },
  { path: '/people/:id', element: <PersonPage /> },
  { path: '/people/:id/review', element: <ReviewAutoFaces /> },
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
    expect(await link('← Back to People')).toHaveAttribute('href', '/people?sort=count');

    await router.navigate('/people/pe1?sort=rating');
    expect(await link('← All people')).toHaveAttribute('href', '/people?sort=count');
    fireEvent.click(await link('Review auto matches'));
    expect(await link('← Back to the person')).toHaveAttribute('href', '/people/pe1?sort=rating');
  });

  it('point at the plain pages when they have not been visited', async () => {
    renderWithRouter(routes, ['/people/pe1/review']);
    expect(await link('← Back to the person')).toHaveAttribute('href', '/people/pe1');
  });
});
