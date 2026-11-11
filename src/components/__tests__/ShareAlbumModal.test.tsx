import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../test/renderWithProviders';
import ShareAlbumModal from '../ShareAlbumModal';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { setAlbumShares: vi.fn(), getMe: vi.fn() },
}));

const show = (sharedWith: string[] = ['a@example.com'], onClose = vi.fn()) => {
  renderWithProviders(<ShareAlbumModal album="Kabini" sharedWith={sharedWith} opened onClose={onClose} />);
  return onClose;
};

const addEmail = async (value: string) => {
  const input = await screen.findByPlaceholderText(/type an email/i);
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
};

describe('ShareAlbumModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.setAlbumShares).mockResolvedValue([]);
    vi.mocked(workerApiClient.getMe).mockResolvedValue({ email: 'me@example.com' });
  });

  it('lists the owner and current emails with avatars, and the Google sign-in note', async () => {
    show();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByLabelText('a@example.com')).toHaveTextContent('A');
    expect(screen.getByText(/must match the person's Google sign-in email/)).toBeInTheDocument();
  });

  it('adds an email and saves the list', async () => {
    const onClose = show();
    await addEmail('b@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(workerApiClient.setAlbumShares).toHaveBeenCalledWith('Kabini', ['a@example.com', 'b@example.com'])
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('removes an email and saves', async () => {
    show(['a@example.com', 'b@example.com']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(workerApiClient.setAlbumShares).toHaveBeenCalledWith('Kabini', ['b@example.com']));
  });

  it('rejects an invalid address inline and does not add it', async () => {
    show();
    await addEmail('not-an-email');
    expect(await screen.findByText(/not a valid email address/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(workerApiClient.setAlbumShares).toHaveBeenCalledWith('Kabini', ['a@example.com']));
  });
});
