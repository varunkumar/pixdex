import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../test/renderWithProviders';
import ShareAlbumModal from '../ShareAlbumModal';

vi.mock('../../services/api/WorkerApiClient', () => ({ workerApiClient: { setAlbumShares: vi.fn() } }));

const show = (sharedWith: string[] = ['a@example.com'], onClose = vi.fn()) => {
  renderWithProviders(<ShareAlbumModal album="Kabini" sharedWith={sharedWith} opened onClose={onClose} />);
  return onClose;
};

const addEmail = async (value: string) => {
  const input = await screen.findByPlaceholderText(/type an email/i);
  // Mantine ignores value writes to an unfocused combobox input (autofill guard).
  input.focus();
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

describe('ShareAlbumModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.setAlbumShares).mockResolvedValue([]);
  });

  it('shows current emails and the Google sign-in note', () => {
    show();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
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
    fireEvent.click(document.body.querySelectorAll<HTMLElement>('.mantine-Pill-remove')[0]);
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
