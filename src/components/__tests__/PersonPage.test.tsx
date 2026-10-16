import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { SerializedFace } from '../../types/api';
import PersonPage from '../PersonPage';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPeople: vi.fn(),
    search: vi.fn(),
    getPhotoFaces: vi.fn(),
    matchPerson: vi.fn(),
    matchPersonAll: vi.fn(),
    assignFace: vi.fn(),
    rejectFace: vi.fn(),
    renamePerson: vi.fn(),
    setPersonCover: vi.fn(),
    deletePerson: vi.fn(),
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

const show = () => renderWithProviders(<PersonPage />, { route: '/people/pe1', path: '/people/:id' });

describe('PersonPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation((f) => `/api${f.thumbnailUrl}`);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, cover: null },
    ]);
    vi.mocked(workerApiClient.search).mockResolvedValue([makePhoto({ id: 'p1' })]);
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([]);
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 0, truncated: false });
    vi.mocked(workerApiClient.matchPerson).mockResolvedValue({
      auto: [face('a1')],
      suggestions: [face('s1'), face('s2')],
      scanned: 300,
      nextCursor: null,
    });
  });

  it('shows photos for the person', async () => {
    show();
    expect(await screen.findByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    await waitFor(() =>
      expect(workerApiClient.search).toHaveBeenCalledWith(expect.objectContaining({ people: ['pe1'] }))
    );
    expect(await screen.findByText('A leopard in a tree.')).toBeInTheDocument();
  });

  it('marks auto-matched faces with an Auto badge and a Not action', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face('a1', { personId: 'pe1', personName: 'Asha', status: 'auto' }),
    ]);
    vi.mocked(workerApiClient.rejectFace).mockResolvedValue(face('a1'));
    show();
    expect(await screen.findByText('Auto')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not Asha' }));
    await waitFor(() => expect(workerApiClient.rejectFace).toHaveBeenCalledWith('a1', 'pe1'));
  });

  it('Set as cover offers the largest face of the person in the photo and marks the current cover', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face('small', { personId: 'pe1', personName: 'Asha', status: 'confirmed', bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } }),
      face('big', { personId: 'pe1', personName: 'Asha', status: 'confirmed', bbox: { x: 0.4, y: 0, w: 0.4, h: 0.4 } }),
      face('other', { personId: 'pe2', personName: 'Ravi', status: 'confirmed', bbox: { x: 0.7, y: 0, w: 0.9, h: 0.9 } }),
    ]);
    vi.mocked(workerApiClient.setPersonCover).mockResolvedValue(undefined);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Set as cover' }));
    await waitFor(() => expect(workerApiClient.setPersonCover).toHaveBeenCalledWith('pe1', 'big'));
  });

  it('shows a Cover badge instead of the button when this photo holds the cover face', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 1, cover: face('c9', { personId: 'pe1' }) },
    ]);
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face('c9', { personId: 'pe1', personName: 'Asha', status: 'confirmed' }),
    ]);
    show();
    expect(await screen.findByText('Cover')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set as cover' })).toBeNull();
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
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe1', expect.any(Function)));
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(workerApiClient.deletePerson).toHaveBeenCalledWith('pe1'));
  });
});
