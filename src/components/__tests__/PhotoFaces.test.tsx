import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { SerializedFace } from '../../types/api';
import PhotoFaces from '../PhotoFaces';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPhotoFaces: vi.fn(),
    getMe: vi.fn(),
    getPeople: vi.fn(),
    createPerson: vi.fn(),
    assignFace: vi.fn(),
    rejectFace: vi.fn(),
    unassignFace: vi.fn(),
    setPersonCover: vi.fn(),
    setPersonLabel: vi.fn(),
    clearPersonLabel: vi.fn(),
    matchPersonAll: vi.fn(),
    ignoreFaces: vi.fn(),
    restoreFaces: vi.fn(),
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
  { id: 'pe1', name: 'Asha', faceCount: 3, photoCount: 3, canEdit: true, cover: null },
  { id: 'pe2', name: 'Ravi', faceCount: 1, photoCount: 1, canEdit: true, cover: null },
];

const show = (canEdit = true) => renderWithProviders(<PhotoFaces photoId="p1" canEdit={canEdit} />);

describe('PhotoFaces', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'owner@example.com', admin: false });
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation((f) => `/api${f.thumbnailUrl}`);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(people);
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 0, truncated: false });
  });

  it('renders nothing when the photo has no faces', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([]);
    const { container } = show();
    await waitFor(() => expect(workerApiClient.getPhotoFaces).toHaveBeenCalledWith('p1'));
    expect(container.querySelector('[data-testid="photo-faces"]')).toBeNull();
    expect(screen.queryByText('People')).toBeNull();
  });

  it('titles the card People and shows a row per face, without a second copy of the photo', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face(), face({ id: 'f2' })]);
    show();
    expect(await screen.findAllByTestId('face-row')).toHaveLength(2);
    expect(screen.getByText('People')).toBeInTheDocument();
    expect(screen.queryByTestId('face-box')).toBeNull();
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

  it('Set as cover calls setPersonCover for a named face, and a cover face shows a badge', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face({ personId: 'pe1', personName: 'Asha', status: 'confirmed' }),
    ]);
    vi.mocked(workerApiClient.setPersonCover).mockResolvedValue(undefined);
    show();
    const button = await screen.findByRole('button', { name: 'Set as cover' });
    expect(button.querySelector('svg')).not.toBeNull(); // the same icon as the photo tiles
    fireEvent.click(button);
    await waitFor(() => expect(workerApiClient.setPersonCover).toHaveBeenCalledWith('pe1', 'f1'));
  });

  it('shows Cover instead of the button when the face is already the cover', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([
      { ...people[0], cover: face({ personId: 'pe1', personName: 'Asha', status: 'confirmed' }) },
      people[1],
    ]);
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face({ personId: 'pe1', personName: 'Asha', status: 'confirmed' }),
    ]);
    show();
    expect(await screen.findByText('Cover')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set as cover' })).toBeNull();
  });

  it('does not offer Set as cover for an unnamed face', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    show();
    await screen.findByText('Unnamed');
    expect(screen.queryByRole('button', { name: 'Set as cover' })).toBeNull();
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

  it('an auto-matched face has Not X but no Remove name', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face({ personId: 'pe1', personName: 'Asha', status: 'auto', matchScore: 0.8 }),
    ]);
    show();
    expect(await screen.findByRole('button', { name: 'Not Asha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove name' })).toBeNull();
  });

  it('tells the owner when matching stopped early', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.assignFace).mockResolvedValue(face({ personId: 'pe2', status: 'confirmed' }));
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 1, truncated: true });
    show();
    fireEvent.click(await screen.findByPlaceholderText('Choose a person'));
    fireEvent.click(await screen.findByRole('option', { name: 'Ravi' }));
    expect(await screen.findByText('Matched 1 more face')).toBeInTheDocument();
    expect(await screen.findByText('Stopped early, run Re-run matching to continue')).toBeInTheDocument();
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
    vi.mocked(workerApiClient.matchPersonAll).mockResolvedValue({ matched: 4, truncated: false });
    show();
    fireEvent.click(await screen.findByPlaceholderText('Choose a person'));
    fireEvent.click(await screen.findByRole('option', { name: 'Ravi' }));
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe2', expect.any(Function), []));
    expect(await screen.findByText('Matched 4 more faces')).toBeInTheDocument();
  });

  it.each([
    ['Not Asha', 'auto' as const],
    ['Remove name', 'confirmed' as const],
  ])('after "%s", naming the face also checks the previous person', async (button, status) => {
    vi.mocked(workerApiClient.getPhotoFaces)
      .mockResolvedValueOnce([face({ personId: 'pe1', personName: 'Asha', status })])
      .mockResolvedValue([face()]);
    vi.mocked(workerApiClient.rejectFace).mockResolvedValue(face());
    vi.mocked(workerApiClient.unassignFace).mockResolvedValue(face());
    vi.mocked(workerApiClient.assignFace).mockResolvedValue(face({ personId: 'pe2', status: 'confirmed' }));
    show();
    fireEvent.click(await screen.findByRole('button', { name: button }));
    fireEvent.click(await screen.findByPlaceholderText('Choose a person'));
    fireEvent.click(await screen.findByRole('option', { name: 'Ravi' }));
    await waitFor(() =>
      expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe2', expect.any(Function), ['pe1'])
    );
  });

  it('closes the new person form while matching is still running', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({ id: 'pe9', name: 'Meera' });
    vi.mocked(workerApiClient.matchPersonAll).mockReturnValue(new Promise(() => {}));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'New person' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Meera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(screen.queryByLabelText('Person name')).toBeNull());
  });

  it('still closes the new person form when matching fails after naming', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    vi.mocked(workerApiClient.createPerson).mockResolvedValue({ id: 'pe9', name: 'Meera' });
    vi.mocked(workerApiClient.matchPersonAll).mockRejectedValue(new Error('boom'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'New person' }));
    fireEvent.change(screen.getByLabelText('Person name'), { target: { value: 'Meera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(workerApiClient.matchPersonAll).toHaveBeenCalledWith('pe9', expect.any(Function), []));
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

  it('hides assign, reject, unassign and new person controls when the photo is not editable', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face(),
      face({ id: 'f2', personId: 'pe1', personName: 'Asha', status: 'confirmed' }),
    ]);
    show(false);
    expect((await screen.findAllByText('Asha')).length).toBeGreaterThan(0);
    for (const name of [/^Not /, 'Remove name', 'New person', 'Set as cover']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('textbox', { name: 'Existing person' })).not.toBeInTheDocument();
    // The name comes from the faces response; the people list (management only) is never requested.
    expect(workerApiClient.getPeople).not.toHaveBeenCalled();
  });

  it('on a photo the caller does not own, shows Unnamed person for an unlabeled person and only offers a private name', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      face({ id: 'f2', personId: 'pe1', personName: null, status: 'confirmed' }),
    ]);
    vi.mocked(workerApiClient.setPersonLabel).mockResolvedValue();
    show(false);
    expect(await screen.findByText('Unnamed person')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Not / })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add my name' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'My name for this person' }), { target: { value: 'Mum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save my name' }));
    await waitFor(() => expect(workerApiClient.setPersonLabel).toHaveBeenCalledWith('pe1', 'Mum'));
  });
});

describe('PhotoFaces: ignoring faces', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.thumbnailUrl).mockImplementation((f) => `/api${f.thumbnailUrl}`);
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(people);
    vi.mocked(workerApiClient.ignoreFaces).mockResolvedValue();
    vi.mocked(workerApiClient.restoreFaces).mockResolvedValue();
  });

  it('ignores an unnamed face and reloads the faces', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(workerApiClient.ignoreFaces).toHaveBeenCalledWith(['f1']));
    await waitFor(() => expect(workerApiClient.getPhotoFaces).toHaveBeenCalledTimes(2));
  });

  it('keeps ignored faces behind a link, numbered after the others', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face({ id: 'x', ignored: true }), face({ id: 'u' })]);
    show();
    const link = await screen.findByRole('button', { name: 'Ignored faces (1)' });
    expect(link).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByTestId('face-row')).toHaveLength(1);
    expect(screen.queryByText('Ignored')).toBeNull();
    fireEvent.click(link);
    expect(screen.getAllByTestId('face-row')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Face 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ignored faces (1)' }));
    expect(screen.getAllByTestId('face-row')).toHaveLength(1);
  });

  it('has no link when nothing is ignored', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face()]);
    show();
    await screen.findByTestId('face-row');
    expect(screen.queryByRole('button', { name: /Ignored faces/ })).toBeNull();
  });

  it('offers only Restore on an ignored face', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face({ ignored: true })]);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Ignored faces (1)' }));
    expect(screen.getByText('Ignored')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ignore' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New person' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(workerApiClient.restoreFaces).toHaveBeenCalledWith(['f1']));
  });

  it('has no Ignore on a named face', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face({ status: 'auto', personId: 'pe1', personName: 'Asha' })]);
    show();
    await screen.findByRole('button', { name: 'Not Asha' });
    expect(screen.queryByRole('button', { name: 'Ignore' })).toBeNull();
  });

  it('shows a viewer neither control', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([face({ ignored: true })]);
    show(false);
    expect(await screen.findByText('Unnamed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ignore' })).toBeNull();
  });
});

describe('PhotoFaces: other faces', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.getPeople).mockResolvedValue(people);
  });
  const sized = (id: string, o: Partial<SerializedFace>) => face({ id, ...o });
  const small = { bbox: { x: 0.1, y: 0.1, w: 0.049, h: 0.2 } };

  it('keeps unnamed faces that are too small or unsure for People behind a link, with their controls', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      sized('narrow', small),
      sized('short', { bbox: { x: 0.2, y: 0.1, w: 0.2, h: 0.049 } }),
      sized('unsure', { detScore: 0.69 }),
      sized('edge', { detScore: 0.7, bbox: { x: 0.3, y: 0.1, w: 0.05, h: 0.05 } }),
    ]);
    show();
    const link = await screen.findByRole('button', { name: 'Other faces (3)' });
    expect(screen.getAllByTestId('face-row')).toHaveLength(1);
    fireEvent.click(link);
    expect(screen.getAllByTestId('face-row')).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: 'Ignore' })).toHaveLength(4);
  });

  it('lists a small face normally once it has a name, and counts an ignored one as ignored only', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([
      sized('named', { ...small, status: 'confirmed', personId: 'pe1', personName: 'Asha' }),
      sized('gone', { ...small, ignored: true }),
    ]);
    show();
    expect(await screen.findByRole('button', { name: 'Ignored faces (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Other faces/ })).toBeNull();
    expect(screen.getAllByTestId('face-row')).toHaveLength(1);
  });

  it('shows a viewer every face with no links', async () => {
    vi.mocked(workerApiClient.getPhotoFaces).mockResolvedValue([sized('narrow', small), sized('gone', { ignored: true })]);
    show(false);
    expect(await screen.findAllByTestId('face-row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /faces \(/i })).toBeNull();
  });
});
