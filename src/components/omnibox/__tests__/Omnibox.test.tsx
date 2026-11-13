import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OmniboxSelection } from '../../../hooks/useOmniboxData';
import { workerApiClient } from '../../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../../test/renderWithProviders';
import Omnibox, { type OmniboxProps } from '../Omnibox';

vi.mock('../../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getPeople: vi.fn(),
    getKnownPeople: vi.fn(),
    getAlbums: vi.fn(),
    searchPage: vi.fn(),
  },
}));

const none: OmniboxSelection = { album: '', people: [], known: [], from: '', to: '', onThisDay: '' };
const own = (id: string, name: string, photoCount = 5) => ({
  id, name, faceCount: 1, photoCount, canEdit: true, cover: null,
});

/** Holds the text like a page would; selection stays as given so each patch is checked through the spy. */
function Harness(props: Partial<OmniboxProps> & { initialText?: string }) {
  const { initialText = '', ...rest } = props;
  const [text, setText] = useState(initialText);
  return (
    <Omnibox
      text={text}
      onText={(t) => {
        setText(t);
        rest.onText?.(t);
      }}
      selection={rest.selection ?? none}
      onSelection={rest.onSelection ?? vi.fn()}
      onSubmit={rest.onSubmit ?? vi.fn()}
      onAskAi={rest.onAskAi}
      askAiBusy={rest.askAiBusy}
      keywordChips={rest.keywordChips}
    />
  );
}

const input = () => screen.getByRole('combobox');
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const loaded = () => waitFor(() => expect(workerApiClient.getAlbums).toHaveBeenCalled());

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(workerApiClient.getPeople).mockResolvedValue([
    own('p1', 'Virat Kohli', 9),
    own('k1', 'Anil Kumar', 5),
    own('k2', 'Arun Kumar', 4),
    own('k3', 'Kiran Kumar', 3),
    own('k4', 'Sunil Kumar', 2),
    own('k5', 'Vijay Kumar', 1),
  ]);
  vi.mocked(workerApiClient.getKnownPeople).mockResolvedValue([
    { id: 'Q1', name: 'MS Dhoni', aliases: [], photoCount: 3 },
  ]);
  vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Goa Trip']);
  vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 12 });
});

describe('Omnibox', () => {
  it('renders the selection as removable chips with colours and a known marker', async () => {
    const onSelection = vi.fn();
    const selection = { ...none, album: 'Goa Trip', people: ['p1'], known: ['Q1'], from: '2020-01-01', to: '2020-12-31' };
    renderWithProviders(<Harness selection={selection} onSelection={onSelection} />);

    const ownRemove = await screen.findByRole('button', { name: 'Remove Virat Kohli' });
    const knownRemove = await screen.findByRole('button', { name: 'Remove MS Dhoni' });
    const albumRemove = screen.getByRole('button', { name: 'Remove Goa Trip' });
    const dateRemove = screen.getByRole('button', { name: /^Remove 2020-01-01/ });

    expect(ownRemove.closest('[data-chip]')?.getAttribute('style')).toContain('--mantine-color-blue-light');
    const knownChip = knownRemove.closest('[data-chip]') as HTMLElement;
    expect(knownChip.getAttribute('style')).toContain('--mantine-color-violet-light');
    expect(within(knownChip).getByText('(known personality)', { exact: false })).toBeInTheDocument();
    expect(albumRemove.closest('[data-chip]')?.getAttribute('style')).toContain('--mantine-color-teal-light');

    fireEvent.click(ownRemove);
    expect(onSelection).toHaveBeenLastCalledWith({ people: [] });
    fireEvent.click(knownRemove);
    expect(onSelection).toHaveBeenLastCalledWith({ known: [] });
    fireEvent.click(albumRemove);
    expect(onSelection).toHaveBeenLastCalledWith({ album: '' });
    fireEvent.click(dateRemove);
    expect(onSelection).toHaveBeenLastCalledWith({ from: '', to: '', onThisDay: '' });
    expect(onSelection).toHaveBeenCalledTimes(4);
  });

  it('shows one On this day chip', async () => {
    renderWithProviders(<Harness selection={{ ...none, onThisDay: '11-13' }} />);
    expect(screen.getByRole('button', { name: /^Remove On this day/ })).toBeInTheDocument();
  });

  it('typing never filters; after the debounce a chip appears and picking it trims only its words', async () => {
    const onSelection = vi.fn();
    const onText = vi.fn();
    renderWithProviders(<Harness onSelection={onSelection} onText={onText} />);
    await loaded();
    type('dho');
    const chip = await screen.findByRole('option', { name: /MS Dhoni/ });
    expect(onSelection).not.toHaveBeenCalled();
    type('beach dhoni at sunset');
    await waitFor(() => expect(screen.getByRole('option', { name: /MS Dhoni/ })).toBeInTheDocument());
    expect(onSelection).not.toHaveBeenCalled();
    expect(chip).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /MS Dhoni/ }));
    expect(onSelection).toHaveBeenCalledWith({ known: ['Q1'] });
    expect(onText).toHaveBeenLastCalledWith('beach at sunset');
  });

  it('two person spans show two chips and Add both with the count, which adds both', async () => {
    const onSelection = vi.fn();
    const onText = vi.fn();
    renderWithProviders(<Harness onSelection={onSelection} onText={onText} />);
    await loaded();
    type('virat dhoni nets');
    expect(await screen.findByRole('option', { name: /Virat Kohli/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /MS Dhoni/ })).toBeInTheDocument();
    const both = await screen.findByRole('option', { name: 'Add both (12 photos)' });
    fireEvent.click(both);
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onSelection).toHaveBeenCalledWith({ people: ['p1'], known: ['Q1'] });
    expect(onText).toHaveBeenLastCalledWith('nets');
  });

  it('an ambiguous span shows 3 chips and +2 more', async () => {
    renderWithProviders(<Harness />);
    await loaded();
    type('kumar');
    await screen.findByRole('option', { name: /Anil Kumar/ });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('offers no person chips with 5 already selected (albums still offered)', async () => {
    const selection = { ...none, people: ['k1', 'k2', 'k3', 'k4', 'k5'] };
    renderWithProviders(<Harness selection={selection} />);
    await loaded();
    type('dhoni goa');
    expect(await screen.findByRole('option', { name: /Goa Trip/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /MS Dhoni/ })).not.toBeInTheDocument();
  });

  it('hides album suggestions while an album is selected', async () => {
    renderWithProviders(<Harness selection={{ ...none, album: 'Goa Trip' }} />);
    await loaded();
    type('goa dhoni');
    expect(await screen.findByRole('option', { name: /MS Dhoni/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Goa Trip/ })).not.toBeInTheDocument();
  });

  it('an empty focused input lists own, known and albums groups', async () => {
    renderWithProviders(<Harness />);
    await loaded();
    fireEvent.focus(input());
    expect(await screen.findByText('Your people')).toBeInTheDocument();
    expect(screen.getByText('Known personalities in your photos')).toBeInTheDocument();
    expect(screen.getByText('Albums')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: /Goa Trip/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /MS Dhoni/ })).toBeInTheDocument();
  });

  it('the empty list has no Albums group while an album is selected', async () => {
    renderWithProviders(<Harness selection={{ ...none, album: 'Goa Trip' }} />);
    await loaded();
    fireEvent.focus(input());
    expect(await screen.findByText('Your people')).toBeInTheDocument();
    expect(screen.queryByText('Albums')).not.toBeInTheDocument();
  });

  it('ArrowDown then Enter picks the highlighted item instead of submitting', async () => {
    const onSelection = vi.fn();
    const onSubmit = vi.fn();
    renderWithProviders(<Harness onSelection={onSelection} onSubmit={onSubmit} />);
    await loaded();
    fireEvent.focus(input());
    await screen.findByText('Your people');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input()).toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSelection).toHaveBeenCalledWith({ people: ['p1'] });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter calls onSubmit', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<Harness onSubmit={onSubmit} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('has no Ask AI button and no Cmd+Enter AI without onAskAi', () => {
    renderWithProviders(<Harness />);
    expect(screen.queryByRole('button', { name: /Ask AI/ })).not.toBeInTheDocument();
  });

  it('Ask AI button and Cmd/Ctrl+Enter call onAskAi when given', () => {
    const onAskAi = vi.fn();
    const onSubmit = vi.fn();
    renderWithProviders(<Harness onAskAi={onAskAi} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask AI/ }));
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true });
    expect(onAskAi).toHaveBeenCalledTimes(3);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not re-trigger Ask AI while busy', () => {
    const onAskAi = vi.fn();
    renderWithProviders(<Harness onAskAi={onAskAi} askAiBusy />);
    fireEvent.click(screen.getByRole('button', { name: /Ask AI/ }));
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    expect(onAskAi).not.toHaveBeenCalled();
  });

  it('keyword chips are removable and editable, and Enter in the keyword input searches again', () => {
    const onChange = vi.fn();
    const onSearchAgain = vi.fn();
    const keywordChips = { terms: ['beach', 'sunset'], onChange, onSearchAgain };
    renderWithProviders(<Harness keywordChips={keywordChips} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove keyword beach' }));
    expect(onChange).toHaveBeenLastCalledWith(['sunset']);

    const kw = screen.getByRole('textbox', { name: 'Add keywords' });
    fireEvent.change(kw, { target: { value: 'boat, sky' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['beach', 'sunset', 'boat', 'sky']);
    expect(onSearchAgain).toHaveBeenCalledTimes(1);
    expect(kw).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Edit keyword beach' }));
    expect(kw).toHaveValue('beach');
    fireEvent.change(kw, { target: { value: 'shore' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['shore', 'sunset']);
    expect(onSearchAgain).toHaveBeenCalledTimes(2);
  });
});
