import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../../services/api/WorkerApiClient';
import { makePhoto } from '../../../test/fixtures';
import { leaveAndGoBack, renderWithRouter } from '../../../test/renderWithProviders';
import type { Fact, InsightTopic } from '../../../types/api';
import InsightsSection from '../InsightsSection';

vi.mock('../../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getInsights: vi.fn(), getOnThisDay: vi.fn(), thumbnailUrl: () => '/api/thumbnails/h1' },
}));

const api = vi.mocked(workerApiClient);
const FACTS: Partial<Record<InsightTopic, Fact[]>> = {
  time: [{ id: 'top-weekday', data: { counts: [0, 0, 0, 100, 0, 0, 0], total: 100 } }],
  gear: [{ id: 'top-lens', data: { lens: 'Long', hits: 20, photos: 30, knownLensPhotos: 40 } }],
};
const thisYear = new Date().getFullYear();

const show = (address = '/') =>
  renderWithRouter(
    [
      { path: '/', element: <InsightsSection /> },
      { path: '/elsewhere', element: <p>elsewhere</p> },
    ],
    [address],
  );
const tile = (name: RegExp) => screen.findByRole('button', { name });

describe('InsightsSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getInsights.mockImplementation(async (topic) => ({ day: '2026-11-28', facts: FACTS[topic] ?? [] }));
    api.getOnThisDay.mockResolvedValue({
      date: '2026-11-28',
      years: [{ year: thisYear - 3, photos: [makePhoto({ id: 'old1', dateTime: `${thisYear - 3}-11-27T06:00:00.000Z` })] }],
    });
  });

  it('asks for On this day with the browser date', async () => {
    show();
    await tile(/Top weekday/);
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(api.getOnThisDay).toHaveBeenCalledWith(local);
  });

  it('shows On this day first, linking each photo, then chips and tiles', async () => {
    show();
    await tile(/Top weekday/);
    const heading = await screen.findByRole('heading', { name: `${thisYear - 3} · 3 years ago` });
    expect(screen.getByRole('link', { name: /leopard in a tree/i })).toHaveAttribute('href', '/photos/old1');
    const all = screen.getByRole('button', { name: 'All' });
    expect(heading.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens one tile at a time', async () => {
    show();
    const weekday = await tile(/Top weekday/);
    const lens = await tile(/Best-rated lens/);
    expect(weekday).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(weekday);
    expect(screen.getByText('Wednesday is your top day')).toBeInTheDocument();
    fireEvent.click(lens);
    expect(screen.queryByText('Wednesday is your top day')).toBeNull();
    expect(screen.getByText('Most of your best photos use Long')).toBeInTheDocument();
    fireEvent.click(lens);
    expect(lens).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the topic in the address and shows only chips that have facts', async () => {
    const { router } = show();
    await tile(/Best-rated lens/);
    expect(screen.queryByRole('button', { name: 'Wildlife' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gear' }));
    expect(router.state.location.search).toBe('?topic=gear');
    expect(screen.queryByRole('button', { name: /Top weekday/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(router.state.location.search).toBe('');
  });

  it.each([
    ['/?topic=gear', false],
    ['/?topic=nonsense', true],
  ])('%s shows time facts: %s', async (address, shown) => {
    show(address);
    await tile(/Best-rated lens/);
    expect(!!screen.queryByRole('button', { name: /Top weekday/ })).toBe(shown);
  });

  it('keeps the open tile after Back', async () => {
    const { router } = show();
    fireEvent.click(await tile(/Top weekday/));
    await leaveAndGoBack(router);
    expect(await tile(/Top weekday/)).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows nothing to a user with no facts and no earlier photos', async () => {
    api.getInsights.mockResolvedValue({ day: '2026-11-28', facts: [] });
    api.getOnThisDay.mockResolvedValue({ date: '2026-11-28', years: [] });
    const { container } = show();
    await vi.waitFor(() => expect(api.getOnThisDay).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(container).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('offers a retry for a failed topic and still shows the others', async () => {
    api.getInsights.mockImplementation(async (topic) => {
      if (topic === 'gear') throw new Error('boom');
      return { day: '2026-11-28', facts: FACTS[topic] ?? [] };
    });
    show();
    await tile(/Top weekday/);
    expect(await screen.findByText('Could not load gear facts.')).toBeInTheDocument();
    api.getInsights.mockImplementation(async (topic) => ({ day: '2026-11-28', facts: FACTS[topic] ?? [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await tile(/Best-rated lens/)).toBeInTheDocument();
  });
});
