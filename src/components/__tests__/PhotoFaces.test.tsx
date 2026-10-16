import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { SerializedFace } from '../../types/api';
import PhotoFaces from '../PhotoFaces';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPhotoFaces: vi.fn(),
    getPeople: vi.fn(),
    createPerson: vi.fn(),
    assignFace: vi.fn(),
    rejectFace: vi.fn(),
    unassignFace: vi.fn(),
    matchPersonAll: vi.fn(),
    thumbnailUrl: vi.fn((f: { thumbnailUrl: string }) => `/api${f.thumbnailUrl}`),
  },
}));

function face(overrides: Partial<SerializedFace> = {}): SerializedFace {
  return {
    id: 'f1',
    photoId: 'p1',
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
  { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 3, cover: null },
  { id: 'pe2', name: 'Ravi', faceCount: 1, photoCount: 1, cover: null },
];

const show = () => renderWithProviders(<PhotoFaces photoId="p1" thumbnailUrl="/api/thumbnails/h1" />);

describe('PhotoFaces', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation((f) => `/api${f.thumbnailUrl}`);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(people);
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 0 });
  });

  it('renders nothing when the photo has no faces', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([]);
    const { container } = show();
    await waitFor(() => expect(workerApiClient.getPhotoFaces).toHaveBeenCalledWith('p1'));
    expect(container.querySelector('[data-testid="photo-faces"]')).toBeNull();
    expect(screen.queryByText('Faces')).toBeNull();
  });

  it('shows a numbered box and a row per face', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face(), face({ id: 'f2' })]);
    show();
    expect(await screen.findAllByTestId('face-row')).toHaveLength(2);
    expect(screen.getAllByTestId('face-box')).toHaveLength(2);
    expect(screen.getByTestId('face-box-1')).toHaveTextContent('1');
    expect(screen.getByTestId('face-box-2')).toHaveTextContent('2');
  });

  it('naming an unnamed face as a new person calls createPerson with the face id', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({
      id: 'pe9',
      name: 'Meera',
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'New person' }));
    fireEvent.change(screen.getByLabelText('Person name'), {
      target: { value: 'Meera' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(workerApiClient.createPerson).toHaveBeenCalledWith('Meera', ['f1']));
  });

  it('shows a friendly message when the name already exists', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.createPerson).mockRejectedValue(new Error('Could not save: 409'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'New person' }));
    fireEvent.change(screen.getByLabelText('Person name'), {
      target: { value: 'Asha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('That name already exists')).toBeInTheDocument();
  });

  it('choosing an existing person calls assignFace', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.assignFace).mockResolvedValue(face({ personId: 'pe1', status: 'confirmed' }));
    show();
    fireEvent.click(await screen.findByPlaceholderText('Choose a person'));
    fireEvent.click(await screen.findByRole('option', { name: 'Asha' }));
    await waitFor(() => expect(workerApiClient.assignFace).toHaveBeenCalledWith('f1', 'pe1'));
  });

  it('Not X calls rejectFace and the row refreshes', async () => {
    const matched = face({
      personId: 'pe1',
      personName: 'Asha',
      status: 'auto',
      matchScore: 0.8,
    });
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValueOnce([matched]).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.rejectFace).mockResolvedValue(face());
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Not Asha' }));
    await waitFor(() => expect(workerApiClient.rejectFace).toHaveBeenCalledWith('f1', 'pe1'));
    expect(await screen.findByText('Unnamed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not Asha' })).toBeNull();
  });

  it('Remove name calls unassignFace', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face({ personId: 'pe1', personName: 'Asha', status: 'confirmed' }),
    ]);
    vi.mocked(workerApiClient.unassignFace).mockResolvedValue(face());
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove name' }));
    await waitFor(() => expect(workerApiClient.unassignFace).toHaveBeenCalledWith('f1'));
  });

  it('an auto-matched face is labelled as such', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face({
        personId: 'pe1',
        personName: 'Asha',
        status: 'auto',
        matchScore: 0.8,
      }),
    ]);
    show();
    expect(await screen.findByText('Auto-matched')).toBeInTheDocument();
  });

  it('naming a face triggers matchPersonAll for that person', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.assignFace).mockResolvedValue(face({ personId: 'pe2', status: 'confirmed' }));
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 4 });
    show();
    fireEvent.click(await screen.findByPlaceholderText('Choose a person'));
    fireEvent.click(await screen.findByRole('option', { name: 'Ravi' }));
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe2'));
    expect(await screen.findByText('Matched 4 more photos')).toBeInTheDocument();
  });

  it('still closes the new person form when matching fails after naming', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({ id: 'pe9', name: 'Meera' });
    vi.mocked(workerApiClient.matchPersonAll).mockRejectedValue(new Error('boom'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'New person' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Meera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe9'));
    await waitFor(() => expect(screen.queryByLabelText('Person name')).toBeNull());
    expect(screen.queryByText('Could not save the name')).toBeNull();
    expect(await screen.findByText('Named, but could not look for more matches')).toBeInTheDocument();
  });

  it('shows a neutral message when removing a name fails', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face({ personId: 'pe1', personName: 'Asha', status: 'confirmed' }),
    ]);
    vi.mocked(workerApiClient.unassignFace).mockRejectedValue(new Error('x'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove name' }));
    expect(await screen.findByText('Something went wrong, try again')).toBeInTheDocument();
  });
});
