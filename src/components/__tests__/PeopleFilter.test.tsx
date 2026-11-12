import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders } from '../../test/renderWithProviders';
import PeopleFilter from '../PeopleFilter';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getPeople: vi.fn(), getKnownPeople: vi.fn() },
}));

const own = (id: string, name: string | null) => ({ id, name, faceCount: 1, photoCount: 1, canEdit: true, cover: null });
const known = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases, photoCount: 4 });

async function typeInPeople(text: string) {
  const input = (await screen.findAllByLabelText('People'))[0];
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: text } });
}

describe('PeopleFilter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([own('a1', 'Asha'), own('b2', 'Dhoni')]);
    vi.mocked(workerApiClient.getKnownPeople).mockResolvedValue([
      known('ms', 'MS Dhoni', ['Mahendra Singh Dhoni']),
      known('ar', 'A. R. Rahman'),
    ]);
  });

  it('renders with only known people present', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
    renderWithProviders(<PeopleFilter people={[]} known={[]} onChange={vi.fn()} />);
    expect((await screen.findAllByLabelText('People'))[0]).toBeInTheDocument();
  });

  it('renders nothing when both lists are empty', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([]);
    vi.mocked(workerApiClient.getKnownPeople).mockResolvedValue([]);
    renderWithProviders(<PeopleFilter people={[]} known={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(workerApiClient.getKnownPeople).toHaveBeenCalled());
    expect(screen.queryAllByLabelText('People')).toHaveLength(0);
  });

  it('typing dho lists the known entry (by alias too) and picking it reports known', async () => {
    const onChange = vi.fn();
    renderWithProviders(<PeopleFilter people={[]} known={[]} onChange={onChange} />);
    await typeInPeople('dho');
    expect(await screen.findByText('Known personalities in your photos')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled(); // typing alone never filters
    fireEvent.click(await screen.findByRole('option', { name: /MS Dhoni/ }));
    expect(onChange).toHaveBeenCalledWith({ people: [], known: ['ms'] });
  });

  it('matches a known alias', async () => {
    renderWithProviders(<PeopleFilter people={[]} known={[]} onChange={vi.fn()} />);
    await typeInPeople('mahendra');
    expect(await screen.findByRole('option', { name: /MS Dhoni/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Asha/ })).not.toBeInTheDocument();
  });

  it('shows own and known entries for the same name, own group first, known marked', async () => {
    renderWithProviders(<PeopleFilter people={[]} known={[]} onChange={vi.fn()} />);
    await typeInPeople('dhoni');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Dhoni');
    expect(options[0]).not.toHaveTextContent('known');
    expect(options[1]).toHaveTextContent('MS Dhoni');
    expect(options[1]).toHaveTextContent('known');
    const headings = screen.getAllByText(/Your people|Known personalities in your photos/).map((e) => e.textContent);
    expect(headings).toEqual(['Your people', 'Known personalities in your photos']);
  });

  it('refuses a sixth selection', async () => {
    vi.mocked(workerApiClient.getPeople).mockResolvedValue([own('a1', 'Asha')]);
    vi.mocked(workerApiClient.getKnownPeople).mockResolvedValue(
      ['k1', 'k2', 'k3', 'k4', 'k5'].map((id) => known(id, `Known ${id}`))
    );
    const onChange = vi.fn();
    renderWithProviders(<PeopleFilter people={['a1']} known={['k1', 'k2', 'k3', 'k4']} onChange={onChange} />);
    const input = (await screen.findAllByLabelText('People'))[0];
    fireEvent.focus(input);
    fireEvent.click(input);
    const option = screen.queryByRole('option', { name: /Known k5/ });
    if (option) fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops selected ids that are in neither list', async () => {
    renderWithProviders(<PeopleFilter people={['a1', 'gone']} known={['ms', 'nope']} onChange={vi.fn()} />);
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    expect(screen.getByText('MS Dhoni')).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
    expect(screen.queryByText('nope')).not.toBeInTheDocument();
  });
});
