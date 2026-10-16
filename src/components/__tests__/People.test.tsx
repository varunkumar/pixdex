import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { FaceGroup, SerializedFace } from '../../types/api';
import People from '../People';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPeople: vi.fn(),
    getFaceGroups: vi.fn(),
    createPerson: vi.fn(),
    assignFaces: vi.fn(),
    matchPersonAll: vi.fn(),
    thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`),
  },
}));

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

const people = [
  { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 2, cover: face('c1') },
  { id: 'pe2', name: 'Ravi', faceCount: 1, photoCount: 1, cover: null },
];
const group = (...ids: string[]): FaceGroup => ({ faces: ids.map((i) => face(i)) });

const show = () => renderWithProviders(<People />, { route: '/people', path: '/people' });

describe('People', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation((f) => `/api${f.thumbnailUrl}`);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(people);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [group('f1', 'f2')],
      scanned: 2,
      nextCursor: null,
    });
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 0, truncated: false });
  });

  it('lists named people and unnamed groups', async () => {
    show();
    const link = await screen.findByRole('link', { name: /Asha/ });
    expect(link).toHaveAttribute('href', '/people/pe1');
    expect(screen.getByRole('link', { name: /Ravi/ })).toHaveAttribute('href', '/people/pe2');
    expect(screen.getByText(/3 faces/)).toBeInTheDocument();
    expect(screen.getByText('Unnamed groups')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Name this group' })).toBeInTheDocument();
  });

  it('shows the largest faces of a group first', async () => {
    const sized = (id: string, w: number) => face(id, { personName: id, bbox: { x: 0.1, y: 0.1, w, h: w } });
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [{ faces: [sized('tiny', 0.05), sized('huge', 0.5), sized('mid', 0.2)] }],
      scanned: 3,
      nextCursor: null,
    });
    show();
    const btn = await screen.findByRole('button', { name: 'Name this group' });
    const card = btn.closest('[data-testid="face-group"]') as HTMLElement;
    expect(within(card).getAllByTestId('face-tile').map((t) => t.getAttribute('aria-label'))).toEqual([
      'huge',
      'mid',
      'tiny',
    ]);
  });

  it('shows at most 8 face tiles per group', async () => {
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({
      groups: [group(...Array.from({ length: 12 }, (_, i) => `g${i}`))],
      scanned: 12,
      nextCursor: null,
    });
    show();
    const btn = await screen.findByRole('button', { name: 'Name this group' });
    const card = btn.closest('[data-testid="face-group"]') as HTMLElement;
    expect(within(card).getAllByTestId('face-tile')).toHaveLength(8);
  });

  it('naming a group calls createPerson with all its face ids', async () => {
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({ id: 'pe9', name: 'Meera' });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Name this group' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: ' Meera ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(workerApiClient.createPerson).toHaveBeenCalledWith('Meera', ['f1', 'f2']));
  });

  it('naming a group then runs matchPersonAll', async () => {
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({ id: 'pe9', name: 'Meera' });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Name this group' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Meera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe9', expect.any(Function)));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Name this group' })).toBeNull());
  });

  it('keeps naming successful when matching fails', async () => {
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({ id: 'pe9', name: 'Meera' });
    vi.mocked(workerApiClient.matchPersonAll).mockRejectedValue(new Error('boom'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Name this group' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Meera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Named, but could not look for more matches')).toBeInTheDocument();
    expect(screen.queryByText('Could not save the name')).toBeNull();
  });

  it('shows a friendly message for a duplicate name', async () => {
    vi.mocked(workerApiClient.createPerson).mockRejectedValue(new Error('Request failed: 409'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Name this group' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('That name already exists')).toBeInTheDocument();
    expect(workerApiClient.matchPersonAll).not.toHaveBeenCalled();
  });

  it('adding a group to an existing person calls assignFaces', async () => {
    vi.mocked(workerApiClient.assignFaces).mockResolvedValue();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Name this group' }));
    fireEvent.click(await screen.findByPlaceholderText('Or add to an existing person'));
    fireEvent.click(await screen.findByRole('option', { name: 'Ravi' }));
    await waitFor(() => expect(workerApiClient.assignFaces).toHaveBeenCalledWith('pe2', ['f1', 'f2']));
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe2', expect.any(Function)));
  });

  it('loads further group pages only as needed and pages them like other lists', async () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => group(`${prefix}${i}a`, `${prefix}${i}b`));
    vi.mocked(workerApiClient.getFaceGroups)
      .mockResolvedValueOnce({ groups: many('x', 6), scanned: 100, nextCursor: 'cur1' })
      .mockResolvedValueOnce({ groups: many('y', 3), scanned: 20, nextCursor: null });
    show();
    expect(await screen.findAllByRole('button', { name: 'Name this group' })).toHaveLength(6);
    expect(screen.getByText('Showing 1-6 of 6+')).toBeInTheDocument();
    expect(workerApiClient.getFaceGroups).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(workerApiClient.getFaceGroups).toHaveBeenLastCalledWith('cur1'));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Name this group' })).toHaveLength(3));
    expect(screen.getByText('Showing 7-9 of 9')).toBeInTheDocument();
  });

  it('pages the named people', async () => {
    const lots = Array.from({ length: 14 }, (_, i) => ({
      id: `p${i}`,
      name: `Person ${String(i).padStart(2, '0')}`,
      faceCount: 14 - i,
      photoCount: 1,
      cover: face(`c${i}`),
    }));
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(lots);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({ groups: [], scanned: 0, nextCursor: null });
    show();
    expect(await screen.findByRole('link', { name: /Person 00/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Person 13/ })).toBeNull();
    expect(screen.getByText('Showing 1-12 of 14')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(await screen.findByRole('link', { name: /Person 13/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Person 00/ })).toBeNull();
  });

  it('shows each person with their cover face and name', async () => {
    show();
    const link = await screen.findByRole('link', { name: /Asha/ });
    expect(within(link).getByTestId('face-tile')).toBeInTheDocument();
    expect(within(link).getByText('Asha')).toBeInTheDocument();
  });

  it('shows an empty state when no faces exist yet', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
    vi.mocked(workerApiClient.getFaceGroups).mockResolvedValue({ groups: [], scanned: 0, nextCursor: null });
    show();
    expect(await screen.findByText(/No faces yet/)).toBeInTheDocument();
  });
});
