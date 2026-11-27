import { useQueryClient } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { matchQueueFor } from '../../services/matchQueue';
import { renderWithProviders } from '../../test/renderWithProviders';
import MatchStatus from '../MatchStatus';

vi.mock('../../services/api/WorkerApiClient', () => ({ workerApiClient: { matchPersonAll: vi.fn() } }));

let finish: () => void;
let report: (scanned: number, matched: number) => void;

const Start = ({ ids }: { ids: string[] }) => {
  const client = useQueryClient();
  useEffect(() => {
    for (const id of ids) matchQueueFor(client).enqueue(id);
  }, [client, ids]);
  return null;
};

const show = (ids: string[]) =>
  renderWithProviders(
    <>
      <Start ids={ids} />
      <MatchStatus />
    </>
  );

const leaving = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

const ONE = ['a'];
const THREE = ['a', 'b', 'c'];

describe('MatchStatus', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerApiClient.matchPersonAll).mockImplementation(
      (_id, onPage) =>
        new Promise((resolve) => {
          report = onPage!;
          finish = () => resolve({ matched: 0, truncated: false });
        })
    );
  });

  it('shows nothing while idle', () => {
    renderWithProviders(<MatchStatus />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(leaving()).toBe(false);
  });

  it('shows progress and warns before leaving while matching, then disappears', async () => {
    show(ONE);
    expect(await screen.findByRole('status')).toHaveTextContent('Looking for more matches');
    act(() => report(200, 4));
    expect(screen.getByRole('status')).toHaveTextContent('scanned 200, matched 4');
    expect(leaving()).toBe(true);
    await act(async () => finish());
    expect(screen.queryByRole('status')).toBeNull();
    expect(leaving()).toBe(false);
  });

  it('counts the people still waiting', async () => {
    show(THREE);
    expect(await screen.findByRole('status')).toHaveTextContent('2 more waiting');
  });
});
