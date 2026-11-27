import { notifications } from '@mantine/notifications';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { leaveAndGoBack, renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import type { PersonSummary, SerializedFace } from '../../types/api';
import { noteRemovedName } from '../../services/matchQueue';
import PersonPage from '../PersonPage';

vi.mock('../../services/matchQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/matchQueue')>();
  return { ...actual, noteRemovedName: vi.fn() };
});

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getMe: vi.fn(),
    getPeople: vi.fn(),
    searchPage: vi.fn(),
    getPhotoFaces: vi.fn(),
    getPersonFaces: vi.fn(),
    matchPerson: vi.fn(),
    matchPersonAll: vi.fn(),
    assignFace: vi.fn(),
    rejectFace: vi.fn(),
    reviewAutoFaces: vi.fn(),
    renamePerson: vi.fn(),
    setPersonCover: vi.fn(),
    deletePerson: vi.fn(),
    setPersonLabel: vi.fn(),
    clearPersonLabel: vi.fn(),
    thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`),
  },
}));
vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

function face(id: string, overrides: Partial<SerializedFace> = {}): SerializedFace {
  return {
    id,
    photoId: `p-${id}`,
    thumbnailUrl: '/thumbnails/h1',
    bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    detScore: 0.99,
    personId: null,
    personName: null,
    status: 'unassigned',
    matchScore: null,
    ...overrides,
  };
}

/** A face of this person on the shown photo. */
const mine = (id: string, overrides: Partial<SerializedFace> = {}) =>
  face(id, { photoId: 'p1', personId: 'pe1', personName: 'Asha', status: 'confirmed', ...overrides });

const show = () => renderWithProviders(<PersonPage />, { route: '/people/pe1', path: '/people/:id' });
const showFaces = (query = '') =>
  renderWithProviders(<PersonPage />, { route: `/people/pe1?tab=faces${query}`, path: '/people/:id' });

describe('PersonPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // The notification store is global and shows only a few at once, so earlier tests' messages must not queue later ones.
    notifications.cleanQueue();
    notifications.clean();
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'owner@example.com', admin: false });
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation((f) => `/api${f.thumbnailUrl}`);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, canEdit: true, cover: null },
    ]);
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [makePhoto({ id: 'p1' })], total: 1 });
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([]);
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 0, truncated: false });
    vi.mocked(workerApiClient.matchPerson).mockResolvedValue({
      auto: [face('a1')],
      suggestions: [face('s1'), face('s2')],
      scanned: 300,
      nextCursor: null,
    });
  });

  it('shows a named spinner while the photos load', async () => {
    vi.mocked(workerApiClient.searchPage).mockReturnValue(new Promise(() => {}));
    show();
    expect(await screen.findByRole('progressbar', { name: 'Loading photos' })).toBeInTheDocument();
  });

  it('shows photos for the person', async () => {
    show();
    expect(await screen.findByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(expect.objectContaining({ people: ['pe1'] }))
    );
    expect((await screen.findAllByText('A leopard in a tree.')).length).toBeGreaterThan(0);
  });

  it('sorts newest first by default and re-sorts through the URL', async () => {
    show();
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(
        expect.objectContaining({ people: ['pe1'], sort: 'date' })
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Best rated' }));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ people: ['pe1'], sort: 'rating' })
      )
    );
  });

  it('shows the cover face beside the name', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, canEdit: true, cover: face('c9', { personId: 'pe1' }) },
    ]);
    show();
    const heading = await screen.findByRole('heading', { name: 'Asha' });
    expect(heading.closest('div')?.parentElement?.querySelector('[data-testid="face-tile"]')).not.toBeNull();
  });

  it('marks auto-matched faces with a quiet icon (not a loud badge) and a Not action', async () => {
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([
      face('a1', { photoId: 'p1', personId: 'pe1', personName: 'Asha', status: 'auto' }),
    ]);
    vi.mocked(workerApiClient.rejectFace).mockResolvedValue(face('a1'));
    show();
    const marker = await screen.findByLabelText('Matched automatically');
    expect(marker.closest('.pdx-tile-actions')).toBeNull();
    expect(marker.closest('.pdx-tile-line')).not.toBeNull(); // sits before the title, clear of the album name at the top left
    expect(marker.closest('.pdx-tile-badges')).toBeNull();
    expect(screen.queryByText('Auto')).not.toBeInTheDocument(); // an icon, not a text badge
    expect(await screen.findByRole('button', { name: /^photo actions for .*leopard/i })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Not Asha' }));
    await waitFor(() => expect(workerApiClient.rejectFace).toHaveBeenCalledWith('a1', 'pe1'));
    // Naming this face next will also check this person's other automatic matches.
    await waitFor(() => expect(noteRemovedName).toHaveBeenCalledWith(expect.anything(), 'a1', 'pe1'));
  });

  it('shows a failed Not action as a notification even though the menu closes', async () => {
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([
      face('a1', { photoId: 'p1', personId: 'pe1', personName: 'Asha', status: 'auto' }),
    ]);
    vi.mocked(workerApiClient.rejectFace).mockRejectedValue(new Error('boom'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Not Asha' }));
    expect(await screen.findByText('Something went wrong, try again')).toBeInTheDocument();
  });

  it('confirms an auto match from the photo menu', async () => {
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([
      face('a1', { photoId: 'p1', personId: 'pe1', personName: 'Asha', status: 'auto' }),
    ]);
    vi.mocked(workerApiClient.reviewAutoFaces).mockResolvedValue({ confirmed: ['a1'], rejected: [] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Confirm Asha' }));
    await waitFor(() =>
      expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledWith('pe1', { confirm: ['a1'], reject: [] })
    );
    await waitFor(() => expect(workerApiClient.getPeople).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('This face had changed, nothing was confirmed')).toBeNull();
  });

  it('says so when the face had changed before it could be confirmed', async () => {
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([
      face('a1', { photoId: 'p1', personId: 'pe1', personName: 'Asha', status: 'auto' }),
    ]);
    vi.mocked(workerApiClient.reviewAutoFaces).mockResolvedValue({ confirmed: [], rejected: [] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Confirm Asha' }));
    expect(await screen.findByText('This face had changed, nothing was confirmed')).toBeInTheDocument();
    await waitFor(() => expect(workerApiClient.getPeople).toHaveBeenCalledTimes(2));
  });

  it('offers no Confirm item for a photo in an album the caller does not own', async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [makePhoto({ id: 'p1', canEdit: false })], total: 1 });
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('a1', { status: 'auto' })]);
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
    await screen.findByRole('menuitem', { name: 'Not Asha' });
    expect(screen.queryByRole('menuitem', { name: /^Confirm/ })).toBeNull();
  });

  it('links the owner to the review of auto matches', async () => {
    show();
    expect(await screen.findByRole('link', { name: 'Review auto matches' })).toHaveAttribute('href', '/people/pe1/review');
  });

  it("asks for the page's faces once", async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({
      results: ['p1', 'p2', 'p3'].map((id) => makePhoto({ id })),
      total: 3,
    });
    show();
    await waitFor(() => expect(workerApiClient.getPersonFaces).toHaveBeenCalledWith('pe1', ['p1', 'p2', 'p3']));
    expect(workerApiClient.getPersonFaces).toHaveBeenCalledTimes(1);
    expect(workerApiClient.getPhotoFaces).not.toHaveBeenCalled();
  });

  it.each([
    ['a page with no photos', true, []],
    ['a person the caller does not own', false, [makePhoto({ id: 'p1' })]],
  ])('makes no faces request for %s', async (_label, canEdit, results) => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, canEdit, cover: null },
    ]);
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results, total: results.length });
    show();
    expect(await screen.findByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    await waitFor(() => expect(workerApiClient.searchPage).toHaveBeenCalled());
    if (results.length) await screen.findAllByText('A leopard in a tree.');
    else await screen.findByText('No photos for this person yet.');
    expect(workerApiClient.getPersonFaces).not.toHaveBeenCalled();
  });

  it('sets the largest face of the person as cover from the tile button', async () => {
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([
      mine('small', { bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } }),
      mine('big', { bbox: { x: 0.4, y: 0, w: 0.4, h: 0.4 } }),
    ]);
    vi.mocked(workerApiClient.setPersonCover).mockResolvedValue(undefined);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Set as cover: A leopard in a tree.' }));
    await waitFor(() => expect(workerApiClient.setPersonCover).toHaveBeenCalledWith('pe1', 'big'));
    expect(screen.queryByRole('button', { name: /^photo actions/i })).toBeNull(); // confirmed only: no menu
  });

  it('reports a failed cover change', async () => {
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('c1')]);
    vi.mocked(workerApiClient.setPersonCover).mockRejectedValue(new Error('boom'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^set as cover/i }));
    expect(await screen.findByText('Something went wrong, try again')).toBeInTheDocument();
  });

  const withCoverOn = (photoId: string) =>
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, canEdit: true, cover: face('c9', { personId: 'pe1', photoId }) },
    ]);

  it('shows the Cover badge and no button on the cover photo', async () => {
    withCoverOn('p1');
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('c9')]);
    show();
    expect((await screen.findByText('Cover')).closest('.pdx-tile-badges')).not.toBeNull();
    await waitFor(() => expect(workerApiClient.getPersonFaces).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^set as cover/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^photo actions/i })).toBeNull();
  });

  it('keeps the menu on a cover photo with an auto match, and confirms the auto face', async () => {
    withCoverOn('p1');
    vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('c9'), mine('a1', { status: 'auto' })]);
    vi.mocked(workerApiClient.reviewAutoFaces).mockResolvedValue({ confirmed: ['a1'], rejected: [] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Confirm Asha', 'Not Asha']);
    expect(screen.queryByRole('button', { name: /^set as cover/i })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm Asha' }));
    await waitFor(() =>
      expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledWith('pe1', { confirm: ['a1'], reject: [] })
    );
  });

  it("shows no controls from the previous page's faces while the next page's load", async () => {
    vi.mocked(workerApiClient.searchPage).mockImplementation(async (q) => ({
      results: [makePhoto({ id: q.offset ? 'p2' : 'p1' })],
      total: 30,
    }));
    vi.mocked(workerApiClient.getPersonFaces)
      .mockResolvedValueOnce([mine('c1')])
      .mockReturnValue(new Promise(() => {}));
    show();
    await screen.findByRole('button', { name: /^set as cover/i });
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(workerApiClient.getPersonFaces).toHaveBeenLastCalledWith('pe1', ['p2']));
    expect(screen.queryByRole('button', { name: /^set as cover/i })).toBeNull();
  });

  it('keeps the controls on the other photos while the faces reload after Not X', async () => {
    vi.mocked(workerApiClient.searchPage)
      .mockResolvedValueOnce({ results: [makePhoto({ id: 'p1' }), makePhoto({ id: 'p2' })], total: 2 })
      .mockResolvedValue({ results: [makePhoto({ id: 'p1' })], total: 1 });
    // The faces for the new set of photos never arrive, so only the earlier answer can show controls.
    vi.mocked(workerApiClient.getPersonFaces).mockImplementation((_, photoIds) =>
      photoIds.length === 2
        ? Promise.resolve([mine('c1'), mine('a2', { photoId: 'p2', status: 'auto' })])
        : new Promise(() => {})
    );
    vi.mocked(workerApiClient.rejectFace).mockResolvedValue(undefined as never);
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Not Asha' }));
    await waitFor(() => expect(workerApiClient.getPersonFaces).toHaveBeenLastCalledWith('pe1', ['p1']));
    expect(screen.getAllByRole('button', { name: /^set as cover/i })).toHaveLength(1);
  });

  it('offers Try again when the faces cannot be loaded', async () => {
    vi.mocked(workerApiClient.getPersonFaces).mockRejectedValueOnce(new Error('boom')).mockResolvedValue([mine('c1')]);
    show();
    expect(await screen.findByText('Could not load photo actions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^set as cover/i })).toBeInTheDocument();
    expect(screen.queryByText('Could not load photo actions')).toBeNull();
  });

  it('keeps the suggestions after Back without looking again', async () => {
    const { router } = renderWithRouter(
      [
        { path: '/people/:id', element: <PersonPage /> },
        { path: '/elsewhere', element: <p>elsewhere</p> },
      ],
      ['/people/pe1']
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review suggestions' }));
    expect(await screen.findAllByTestId('suggestion')).toHaveLength(2);
    await leaveAndGoBack(router);
    expect(await screen.findAllByTestId('suggestion')).toHaveLength(2);
    expect(workerApiClient.matchPerson).toHaveBeenCalledTimes(1);
  });

  it('Review suggestions shows only the suggestion band', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review suggestions' }));
    await waitFor(() => expect(workerApiClient.matchPerson).toHaveBeenCalledWith('pe1'));
    expect(await screen.findAllByRole('button', { name: 'Yes' })).toHaveLength(2);
    expect(screen.getAllByTestId('suggestion')).toHaveLength(2);
  });

  it('Check more follows the cursor and appends', async () => {
    vi.mocked(workerApiClient.matchPerson)
      .mockResolvedValueOnce({ auto: [], suggestions: [face('s1')], scanned: 300, nextCursor: 'c1' })
      .mockResolvedValueOnce({ auto: [], suggestions: [face('s2')], scanned: 20, nextCursor: null });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check more' }));
    await waitFor(() => expect(workerApiClient.matchPerson).toHaveBeenLastCalledWith('pe1', { cursor: 'c1' }));
    await waitFor(() => expect(screen.getAllByTestId('suggestion')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Check more' })).toBeNull();
  });

  it('Yes on a suggestion calls assignFace', async () => {
    vi.mocked(workerApiClient.assignFace).mockResolvedValue(face('s1'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review suggestions' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Yes' }))[0]);
    await waitFor(() => expect(workerApiClient.assignFace).toHaveBeenCalledWith('s1', 'pe1'));
    await waitFor(() => expect(screen.getAllByTestId('suggestion')).toHaveLength(1));
  });

  it('Not them calls rejectFace and removes the tile', async () => {
    vi.mocked(workerApiClient.rejectFace).mockResolvedValue(face('s1'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review suggestions' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Not them' }))[0]);
    await waitFor(() => expect(workerApiClient.rejectFace).toHaveBeenCalledWith('s1', 'pe1'));
    await waitFor(() => expect(screen.getAllByTestId('suggestion')).toHaveLength(1));
  });

  it('Re-run matching calls matchPersonAll', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run matching' }));
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe1', expect.any(Function), undefined));
  });

  it('Re-run matching says when there is nothing new', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run matching' }));
    expect(await screen.findByText('No new matches')).toBeInTheDocument();
  });

  it('Re-run matching cannot be pressed again while it runs', async () => {
    vi.mocked(workerApiClient.matchPersonAll).mockReturnValue(new Promise(() => {}));
    show();
    const button = await screen.findByRole('button', { name: 'Re-run matching' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('Re-run matching says when it stopped early', async () => {
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 2, truncated: true });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run matching' }));
    expect(await screen.findByText('Matched 2 more faces')).toBeInTheDocument();
    expect(await screen.findByText('Stopped early, run Re-run matching to continue')).toBeInTheDocument();
  });

  it('renames the person', async () => {
    vi.mocked(workerApiClient.renamePerson).mockResolvedValue();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Asha K' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(workerApiClient.renamePerson).toHaveBeenCalledWith('pe1', 'Asha K'));
  });

  it('deleting a person asks for confirmation first', async () => {
    vi.mocked(workerApiClient.deletePerson).mockResolvedValue();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(workerApiClient.deletePerson).not.toHaveBeenCalled();
    expect(screen.getByText('Delete Asha? Their faces become unnamed again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(workerApiClient.deletePerson).toHaveBeenCalledWith('pe1'));
  });

  it('pages the person\'s photos instead of loading more', async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [makePhoto({ id: 'p1' })], total: 30 });
    show();
    expect(await screen.findByText('Showing 1-24 of 30')).toBeInTheDocument();
    expect(screen.queryByText('Show more photos')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith(
        expect.objectContaining({ people: ['pe1'], limit: 24, offset: 24 })
      )
    );
  });

  it('hides rename, delete, matching and per-photo face controls for a person the caller does not own', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, canEdit: false, cover: null },
    ]);
    show();
    expect(await screen.findByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    await screen.findAllByText('A leopard in a tree.');
    for (const name of ['Rename', 'Delete', 'Review suggestions', 'Re-run matching', 'Set as cover', 'Photo actions']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${name}`, 'i') })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: 'Review auto matches' })).toBeNull();
  });

  it('shows Unnamed person for a viewer with no label, and lets them set their own name and nothing else', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: null, faceCount: 3, photoCount: 1, canEdit: false, cover: null },
    ]);
    vi.mocked(workerApiClient.setPersonLabel).mockResolvedValue();
    show();
    expect(await screen.findByRole('heading', { name: 'Unnamed person' })).toBeInTheDocument();
    for (const name of ['Rename', 'Delete', 'Review suggestions', 'Re-run matching']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add my name' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'My name for this person' }), { target: { value: 'Aunt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save my name' }));
    await waitFor(() => expect(workerApiClient.setPersonLabel).toHaveBeenCalledWith('pe1', 'Aunt'));
  });

  it('does not offer the viewer label editor to the owner', async () => {
    show();
    await screen.findByRole('heading', { name: 'Asha' });
    expect(screen.queryByRole('button', { name: /my name/ })).not.toBeInTheDocument();
  });

  describe('Faces tab', () => {
    const personIs = (overrides: Partial<PersonSummary> = {}) =>
      vi.mocked(workerApiClient.getPeople).mockResolvedValue([
        { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, canEdit: true, cover: null, ...overrides },
      ]);
    const twoFaces = () => [
      mine('left', { bbox: { x: 0.1, y: 0, w: 0.2, h: 0.2 } }),
      mine('right', { bbox: { x: 0.6, y: 0, w: 0.2, h: 0.2 } }),
    ];
    const twoPhotos = () =>
      vi.mocked(workerApiClient.searchPage).mockResolvedValue({
        results: [makePhoto({ id: 'p1' }), makePhoto({ id: 'p2' })],
        total: 2,
      });

    it('opens Photos first and moves to Faces from its tab', async () => {
      vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('f1')]);
      show();
      expect(await screen.findByRole('tab', { name: 'Photos' })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByRole('button', { name: /^switch to 1 column/i })).toBeInTheDocument();
      expect(screen.queryByTestId('face-cut')).toBeNull();
      fireEvent.click(screen.getByRole('tab', { name: 'Faces (3)' }));
      expect(await screen.findByTestId('face-cut')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^switch to/i })).toBeNull();
      expect(screen.getByRole('button', { name: 'Best rated' })).toBeInTheDocument();
    });

    it('keeps the page and sort when the tab changes', async () => {
      vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [makePhoto({ id: 'p1' })], total: 48 });
      renderWithProviders(<PersonPage />, { route: '/people/pe1?page=2&sort=rating', path: '/people/:id' });
      fireEvent.click(await screen.findByRole('tab', { name: 'Faces (3)' }));
      expect(await screen.findByText('Showing 25-48 of 48')).toBeInTheDocument();
      expect(workerApiClient.searchPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 24, sort: 'rating' })
      );
    });

    it('sets a face as cover from its tile', async () => {
      vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('f1', { status: 'auto' })]);
      vi.mocked(workerApiClient.setPersonCover).mockResolvedValue(undefined);
      showFaces();
      await screen.findByTestId('face-cut');
      fireEvent.click(await screen.findByRole('button', { name: 'Set as cover: A leopard in a tree.' }));
      await waitFor(() => expect(workerApiClient.setPersonCover).toHaveBeenCalledWith('pe1', 'f1'));
      expect(screen.getByLabelText('Matched automatically').closest('.pdx-tile-line')).not.toBeNull();
    });

    it.each([
      ['Not Asha', () => expect(workerApiClient.rejectFace).toHaveBeenCalledWith('f1', 'pe1')],
      [
        'Confirm Asha',
        () => expect(workerApiClient.reviewAutoFaces).toHaveBeenCalledWith('pe1', { confirm: ['f1'], reject: [] }),
      ],
    ])('applies %s from the face tile menu', async (item, check) => {
      vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('f1', { status: 'auto' })]);
      vi.mocked(workerApiClient.rejectFace).mockResolvedValue(undefined as never);
      vi.mocked(workerApiClient.reviewAutoFaces).mockResolvedValue({ confirmed: ['f1'], rejected: [] });
      showFaces();
      await screen.findByTestId('face-cut');
      fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
      fireEvent.click(await screen.findByRole('menuitem', { name: item }));
      await waitFor(check);
    });

    it('acts on the face of the tile, not the largest face', async () => {
      vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([
        mine('big', { bbox: { x: 0.1, y: 0, w: 0.4, h: 0.4 } }),
        mine('small', { bbox: { x: 0.6, y: 0, w: 0.1, h: 0.1 } }),
      ]);
      vi.mocked(workerApiClient.setPersonCover).mockResolvedValue(undefined);
      showFaces();
      fireEvent.click(await screen.findByRole('button', { name: /^set as cover: .*, face 2$/i }));
      await waitFor(() => expect(workerApiClient.setPersonCover).toHaveBeenCalledWith('pe1', 'small'));
    });

    it('marks the cover face only', async () => {
      personIs({ cover: mine('left') });
      vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue(twoFaces());
      showFaces();
      expect((await screen.findByText('Cover')).closest('.pdx-tile-badges')).not.toBeNull();
      expect(screen.getAllByText('Cover')).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: /^set as cover/i })).toHaveLength(1);
    });

    it('shows a viewer the faces with no controls or sparkle', async () => {
      personIs({ canEdit: false, cover: mine('f1') });
      vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('f1', { status: 'auto' })]);
      showFaces();
      expect(await screen.findByTestId('face-cut')).toBeInTheDocument();
      expect(workerApiClient.getPersonFaces).toHaveBeenCalledWith('pe1', ['p1']);
      expect(screen.queryByRole('button', { name: /^(set as cover|photo actions)/i })).toBeNull();
      expect(screen.queryByLabelText('Matched automatically')).toBeNull();
      expect(screen.queryByText('Cover')).toBeNull();
    });

    it('shows loading, not the old faces, while the next page loads', async () => {
      vi.mocked(workerApiClient.searchPage).mockImplementation(async (q) => ({
        results: [makePhoto({ id: q.offset ? 'p2' : 'p1' })],
        total: 30,
      }));
      vi.mocked(workerApiClient.getPersonFaces)
        .mockResolvedValueOnce([mine('c1')])
        .mockReturnValue(new Promise(() => {}));
      showFaces();
      await screen.findByTestId('face-cut');
      fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
      await waitFor(() => expect(workerApiClient.getPersonFaces).toHaveBeenLastCalledWith('pe1', ['p2']));
      expect(screen.getByRole('progressbar', { name: 'Loading faces' })).toBeInTheDocument();
      expect(screen.queryByTestId('face-cut')).toBeNull();
    });

    it('keeps the other faces while they load again after Not X', async () => {
      vi.mocked(workerApiClient.searchPage)
        .mockResolvedValueOnce({ results: [makePhoto({ id: 'p1' }), makePhoto({ id: 'p2' })], total: 2 })
        .mockResolvedValue({ results: [makePhoto({ id: 'p1' })], total: 1 });
      vi.mocked(workerApiClient.getPersonFaces).mockImplementation((_, photoIds) =>
        photoIds.length === 2
          ? Promise.resolve([mine('c1'), mine('a2', { photoId: 'p2', status: 'auto' })])
          : new Promise(() => {})
      );
      vi.mocked(workerApiClient.rejectFace).mockResolvedValue(undefined as never);
      showFaces();
      fireEvent.click(await screen.findByRole('button', { name: /^photo actions/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Not Asha' }));
      await waitFor(() => expect(workerApiClient.getPersonFaces).toHaveBeenLastCalledWith('pe1', ['p1']));
      expect(screen.getAllByTestId('face-cut')).toHaveLength(1);
      expect(screen.queryByRole('progressbar', { name: 'Loading faces' })).toBeNull();
    });

    it('offers Try again when the faces fail on the Faces tab', async () => {
      vi.mocked(workerApiClient.getPersonFaces).mockRejectedValue(new Error('boom'));
      showFaces();
      expect(await screen.findByText('Could not load faces')).toBeInTheDocument();
      expect(screen.queryByText('No faces on this page.')).toBeNull();
      expect(screen.queryByRole('progressbar', { name: 'Loading faces' })).toBeNull();
      vi.mocked(workerApiClient.getPersonFaces).mockResolvedValue([mine('c1')]);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByTestId('face-cut')).toBeInTheDocument();
    });

    it('says when the page has no faces', async () => {
      twoPhotos();
      showFaces();
      expect(await screen.findByText('No faces on this page.')).toBeInTheDocument();
    });

    it('does not load forever for an unknown person', async () => {
      vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
      showFaces();
      expect(await screen.findByText('This person was not found.')).toBeInTheDocument();
      expect((await screen.findAllByText('A leopard in a tree.')).length).toBeGreaterThan(0);
      expect(screen.queryByRole('progressbar', { name: 'Loading faces' })).toBeNull();
      expect(screen.queryByRole('tab')).toBeNull();
    });

    it('hides the tabs for a person with no photos', async () => {
      personIs({ photoCount: 0, faceCount: 0 });
      vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
      showFaces();
      expect(await screen.findByText('No photos for this person yet.')).toBeInTheDocument();
      await screen.findByRole('heading', { name: 'Asha' });
      expect(screen.queryByRole('tab')).toBeNull();
      expect(screen.queryByRole('progressbar', { name: 'Loading faces' })).toBeNull();
    });
  });
});
