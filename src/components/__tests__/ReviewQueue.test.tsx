import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { refreshAfterNaming, refreshAfterReview } from '../../services/matchQueue';
import { renderWithProviders } from '../../test/renderWithProviders';
import ReviewQueue from '../ReviewQueue';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPeople: vi.fn(),
    getReviewQueue: vi.fn(),
    thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`),
  },
}));

const person = (id: string, name: string, canEdit = true) => ({
  id,
  name,
  faceCount: 200,
  photoCount: 100,
  canEdit,
  cover: null,
});
const show = () => renderWithProviders(<ReviewQueue />, { route: '/review', path: '/review' });

describe('ReviewQueue', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([person('pe1', 'Asha'), person('pe2', 'Ravi')]);
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([
      { id: 'pe2', count: 180 },
      { id: 'pe1', count: 1 },
    ]);
  });

  it("lists people in the Worker's order with counts and a way into each review", async () => {
    show();
    const links = await screen.findAllByRole('link', { name: /^Review / });
    expect(links.map((l) => [l.getAttribute('aria-label'), l.getAttribute('href')])).toEqual([
      ['Review Ravi', '/people/pe2/review'],
      ['Review Asha', '/people/pe1/review'],
    ]);
    expect(screen.getByText('180 to review')).toBeInTheDocument();
    expect(screen.getByText('1 to review')).toBeInTheDocument();
  });

  it('says so when nothing is pending', async () => {
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([]);
    show();
    expect(await screen.findByText('Nothing to review.')).toBeInTheDocument();
  });

  it('can try again after a failure', async () => {
    vi.mocked(workerApiClient.getReviewQueue).mockRejectedValueOnce(new Error('500'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('180 to review')).toBeInTheDocument();
  });

  it.each([
    ['a review', (c: QueryClient) => refreshAfterReview(c)],
    ['naming', (c: QueryClient) => refreshAfterNaming(c, ['f1'])],
  ])('is marked out of date by %s without being requested again at once', (_label, change) => {
    const client = new QueryClient();
    client.setQueryData(['review-queue'], []);
    const spy = vi.spyOn(client, 'invalidateQueries');
    change(client);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['review-queue'], refetchType: 'none' });
    expect(client.getQueryState(['review-queue'])?.isInvalidated).toBe(true);
  });
});
