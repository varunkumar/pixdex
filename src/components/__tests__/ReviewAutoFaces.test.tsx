import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { noteRemovedName } from '../../services/matchQueue';
import { leaveAndGoBack, renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import type { SerializedFace } from '../../types/api';
import ReviewAutoFaces from '../ReviewAutoFaces';

vi.mock('../../services/matchQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/matchQueue')>();
  return { ...actual, noteRemovedName: vi.fn() };
});

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPeople: vi.fn(),
    getAutoFaces: vi.fn(),
    reviewAutoFaces: vi.fn(),
    getReviewQueue: vi.fn(),
    thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`),
  },
}));

const face = (id: string, overrides: Partial<SerializedFace> = {}): SerializedFace => ({
  id,
  photoId: `p-${id}`,
  thumbnailUrl: `/thumbnails/h-${id}`,
  cropUrl: `/faces/${id}/crop`,
  bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
  detScore: 0.99,
  personId: 'pe1',
  personName: 'Asha',
  status: 'auto',
  matchScore: 0.6,
  ignored: false,
  ...overrides,
});

const person = { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 3, canEdit: true, cover: null };
const show = () => renderWithProviders(<ReviewAutoFaces />, { route: '/people/pe1/review', path: '/people/:id/review' });
const pictures = () => Array.from(document.querySelectorAll<HTMLImageElement>('img[data-face-picture]'));
const loadAll = () => pictures().forEach((img) => fireEvent.load(img));
const tile = (n: number) => screen.getByRole('button', { name: `Face ${n} is Asha` });
const button = (name: string) => screen.getByRole('button', { name });

/** Renders and waits for the first page of three faces. */
async function showPage() {
  show();
  await screen.findByRole('button', { name: 'Face 1 is Asha' });
}

describe('ReviewAutoFaces', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation((f) => `/api${f.thumbnailUrl}`);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([person]);
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([]);
    vi.mocked(workerApiClient.getAutoFaces).mockImplementation(async (_id, cursor) =>
      cursor
        ? { faces: [face('d')], nextCursor: null }
        : { faces: [face('a'), face('b'), face('c')], nextCursor: '0.6|3' }
    );
    vi.mocked(workerApiClient.reviewAutoFaces).mockImplementation(async (_id, body) => ({
      confirmed: body.confirm,
      rejected: body.reject,
    }));
  });

  it('starts with every face ticked and links each to its photo in a new tab', async () => {
    await showPage();
    for (const n of [1, 2, 3]) expect(tile(n)).toHaveAttribute('aria-pressed', 'true');
    const link = screen.getByRole('link', { name: 'Open the photo of face 2' });
    expect(link).toHaveAttribute('href', '/photos/p-b');
    expect(link).toHaveAttribute('target', '_blank');
    expect(pictures().map((i) => i.getAttribute('src'))).toEqual(['/api/faces/a/crop', '/api/faces/b/crop', '/api/faces/c/crop']);
  });

  it('waits for every picture before saving anything', async () => {
    await showPage();
    expect(button('Confirm 3')).toBeDisabled();
    fireEvent.load(pictures()[0]);
    fireEvent.load(pictures()[1]);
    expect(button('Confirm 3')).toBeDisabled();
    fireEvent.load(pictures()[2]);
    expect(button('Confirm 3')).toBeEnabled();
  });

  it('confirms the ticked faces, leaves the unticked ones auto and loads the next page', async () => {
    await showPage();
    loadAll();
    fireEvent.click(tile(2));
    expect(tile(2)).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button('Confirm 2'));
    await screen.findByText('Confirmed 2.');
    expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledWith('pe1', { confirm: ['a', 'c'], reject: [] });
    expect(noteRemovedName).not.toHaveBeenCalled();
    await waitFor(() => expect(workerApiClient.getAutoFaces).toHaveBeenLastCalledWith('pe1', '0.6|3'));
    await waitFor(() => expect(pictures()).toHaveLength(1));
  });

  it('can mark the unticked faces as Not A and remembers them as removed', async () => {
    await showPage();
    loadAll();
    expect(screen.queryByRole('button', { name: /Not Asha/ })).toBeNull();
    fireEvent.click(tile(2));
    fireEvent.click(button('Confirm 2, mark 1 as Not Asha'));
    await screen.findByText('Confirmed 2, marked 1 as Not Asha.');
    expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledWith('pe1', { confirm: ['a', 'c'], reject: ['b'] });
    expect(noteRemovedName).toHaveBeenCalledTimes(1);
    expect(noteRemovedName).toHaveBeenCalledWith(expect.anything(), 'b', 'pe1');
  });

  it('only offers to mark them when nothing is ticked', async () => {
    await showPage();
    loadAll();
    for (const n of [1, 2, 3]) fireEvent.click(tile(n));
    expect(screen.queryByRole('button', { name: /^Confirm/ })).toBeNull();
    fireEvent.click(button('Mark 3 as Not Asha'));
    await waitFor(() =>
      expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledWith('pe1', { confirm: [], reject: ['a', 'b', 'c'] })
    );
  });

  it('sends a face whose picture failed in neither list', async () => {
    await showPage();
    fireEvent.load(pictures()[0]);
    fireEvent.error(pictures()[1]);
    fireEvent.load(pictures()[2]);
    expect(screen.getByText('Picture did not load')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Face 2 is Asha' })).toBeNull();
    fireEvent.click(tile(3));
    fireEvent.click(button('Confirm 1, mark 1 as Not Asha'));
    await waitFor(() =>
      expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledWith('pe1', { confirm: ['a'], reject: ['c'] })
    );
  });

  it('reports faces that had changed since the page was shown', async () => {
    vi.mocked(workerApiClient.reviewAutoFaces).mockResolvedValue({ confirmed: ['a'], rejected: [] });
    await showPage();
    loadAll();
    fireEvent.click(button('Confirm 3'));
    await screen.findByText('Confirmed 1. 2 had changed and were skipped.');
  });

  it('skips a page without writing, ends, and starts again from the weakest match', async () => {
    await showPage();
    fireEvent.click(button('Skip page'));
    await waitFor(() => expect(pictures()).toHaveLength(1));
    fireEvent.click(button('Skip page'));
    await screen.findByText('No more auto matches.');
    expect(workerApiClient.reviewAutoFaces).not.toHaveBeenCalled();
    fireEvent.click(button('Start again'));
    await waitFor(() => expect(pictures()).toHaveLength(3));
    expect(workerApiClient.getAutoFaces).toHaveBeenLastCalledWith('pe1', undefined);
  });

  it('says so when there is nothing to review', async () => {
    vi.mocked(workerApiClient.getAutoFaces).mockResolvedValue({ faces: [], nextCursor: null });
    show();
    expect(await screen.findByText('No more auto matches.')).toBeInTheDocument();
  });

  it('keeps the page and the ticks when saving fails', async () => {
    vi.mocked(workerApiClient.reviewAutoFaces).mockRejectedValue(new Error('Could not save: 500'));
    await showPage();
    loadAll();
    fireEvent.click(tile(2));
    fireEvent.click(button('Confirm 2'));
    await screen.findByText('Something went wrong, try again');
    expect(tile(2)).toHaveAttribute('aria-pressed', 'false');
    expect(button('Confirm 2')).toBeEnabled();
    expect(workerApiClient.getAutoFaces).toHaveBeenCalledTimes(1);
  });

  it('sends one request for a double click', async () => {
    vi.mocked(workerApiClient.reviewAutoFaces).mockReturnValue(new Promise(() => {}));
    await showPage();
    loadAll();
    const confirm = button('Confirm 3');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledTimes(1));
  });

  it('keeps the same page and ticks when the tab is focused again', async () => {
    await showPage();
    fireEvent.click(tile(1));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await Promise.resolve();
    expect(workerApiClient.getAutoFaces).toHaveBeenCalledTimes(1);
    expect(tile(1)).toHaveAttribute('aria-pressed', 'false');
    focusManager.setFocused(undefined);
  });

  it('links back to the list and asks for it only once the pages are finished', async () => {
    await showPage();
    expect(screen.getByRole('link', { name: 'All to review' })).toHaveAttribute('href', '/review');
    expect(workerApiClient.getReviewQueue).not.toHaveBeenCalled();
  });

  it('offers the person with the most pending next, never one already finished in this visit', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      person,
      { ...person, id: 'pe2', name: 'Ravi' },
      { ...person, id: 'pe3', name: 'Meera' },
    ]);
    vi.mocked(workerApiClient.getAutoFaces).mockResolvedValue({ faces: [], nextCursor: null });
    // pe1 stays the largest, as after skipped pages.
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([
      { id: 'pe1', count: 180 },
      { id: 'pe2', count: 97 },
      { id: 'pe3', count: 35 },
    ]);
    show();
    fireEvent.click(await screen.findByRole('link', { name: 'Next: Ravi (97)' }));
    await screen.findByRole('heading', { name: 'Review auto matches: Ravi' });
    expect(await screen.findByRole('link', { name: 'Next: Meera (35)' })).toHaveAttribute('href', '/people/pe3/review');
    expect(workerApiClient.getAutoFaces).toHaveBeenLastCalledWith('pe2', undefined);
  });

  it('offers no next person when nobody else is pending', async () => {
    vi.mocked(workerApiClient.getAutoFaces).mockResolvedValue({ faces: [], nextCursor: null });
    vi.mocked(workerApiClient.getReviewQueue).mockResolvedValue([{ id: 'pe1', count: 2 }]);
    show();
    await screen.findByText('No more auto matches.');
    await waitFor(() => expect(workerApiClient.getReviewQueue).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /^Next:/ })).toBeNull();
  });

  const showWithHistory = () =>
    renderWithRouter(
      [
        { path: '/people/:id/review', element: <ReviewAutoFaces /> },
        { path: '/elsewhere', element: <p>elsewhere</p> },
      ],
      ['/people/pe1/review']
    );

  it('comes back to the same page with the same ticks after Back', async () => {
    const { router } = showWithHistory();
    await screen.findByRole('button', { name: 'Face 3 is Asha' });
    fireEvent.click(button('Skip page'));
    await waitFor(() => expect(pictures()).toHaveLength(1));
    fireEvent.click(tile(1));
    await leaveAndGoBack(router);
    await waitFor(() => expect(tile(1)).toHaveAttribute('aria-pressed', 'false'));
    expect(pictures()).toHaveLength(1);
    expect(workerApiClient.getAutoFaces).toHaveBeenLastCalledWith('pe1', '0.6|3');
  });

  it('starts from the weakest match when the review is opened again, not gone back to', async () => {
    const { router } = showWithHistory();
    await screen.findByRole('button', { name: 'Face 3 is Asha' });
    fireEvent.click(button('Skip page'));
    await waitFor(() => expect(pictures()).toHaveLength(1));
    await act(() => router.navigate('/people/pe1/review'));
    await waitFor(() => expect(pictures()).toHaveLength(3));
  });

  it('shows a viewer nothing and requests no faces', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([{ ...person, canEdit: false }]);
    show();
    expect(await screen.findByText('Only the owner of this person can review their matches.')).toBeInTheDocument();
    expect(workerApiClient.getAutoFaces).not.toHaveBeenCalled();
  });
});
