import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import PhotoReview from '../PhotoReview';

vi.mock('../../services/api/WorkerApiClient', () => ({ workerApiClient: { updatePhoto: vi.fn() } }));

const photo = makePhoto({
  id: 'p1',
  shortCaption: 'Serpent eagle',
  subjects: ['serpent eagle'],
  tags: ['raptor'],
  combinedScore: 6,
  userRating: null,
  overrides: { shortCaption: null, subjects: null, tags: null },
});

describe('PhotoReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.updatePhoto).mockResolvedValue(photo);
  });

  it('saves a star rating', async () => {
    renderWithProviders(<PhotoReview photo={photo} />);
    // Mantine handles the click on the star's label, which follows its hidden radio input.
    fireEvent.click(screen.getByRole('radio', { name: '4' }).nextElementSibling!);
    await waitFor(() => expect(workerApiClient.updatePhoto).toHaveBeenCalledWith('p1', { userRating: 4 }));
  });

  it('clears the rating', async () => {
    renderWithProviders(<PhotoReview photo={{ ...photo, userRating: 3 }} />);
    fireEvent.click(screen.getByText('Clear rating'));
    await waitFor(() => expect(workerApiClient.updatePhoto).toHaveBeenCalledWith('p1', { userRating: null }));
  });

  it('saves a corrected title and subjects', async () => {
    renderWithProviders(<PhotoReview photo={photo} />);
    fireEvent.click(screen.getByText('Edit details'));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Crested hawk-eagle' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(workerApiClient.updatePhoto).toHaveBeenCalledWith('p1', {
        caption: 'Crested hawk-eagle',
        subjects: ['serpent eagle'],
        tags: ['raptor'],
      })
    );
  });

  it('offers a reset only once something is overridden', async () => {
    const { unmount } = renderWithProviders(<PhotoReview photo={photo} />);
    fireEvent.click(screen.getByText('Edit details'));
    expect(screen.queryByText('Reset to AI')).not.toBeInTheDocument();
    unmount();

    renderWithProviders(
      <PhotoReview photo={{ ...photo, overrides: { shortCaption: 'x', subjects: null, tags: null } }} />
    );
    fireEvent.click(screen.getByText('Edit details'));
    fireEvent.click(screen.getByText('Reset to AI'));
    await waitFor(() =>
      expect(workerApiClient.updatePhoto).toHaveBeenCalledWith('p1', { caption: null, subjects: null, tags: null })
    );
  });
});
