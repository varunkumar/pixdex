import { notifications } from '@mantine/notifications';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../api/WorkerApiClient';
import { matchQueueFor, refreshAfterNaming } from '../matchQueue';

vi.mock('../api/WorkerApiClient', () => ({ workerApiClient: { matchPersonAll: vi.fn() } }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

type Result = { matched: number; truncated: boolean };

/** matchPersonAll calls that finish only when the test says so. */
function deferredRuns() {
  const runs: {
    id: string;
    onPage: (scanned: number, matched: number) => void;
    resolve: (r: Result) => void;
    reject: (e: Error) => void;
  }[] = [];
  vi.mocked(workerApiClient.matchPersonAll).mockImplementation(
    (id, onPage) =>
      new Promise<Result>((resolve, reject) => {
        runs.push({ id, onPage: onPage!, resolve, reject });
      })
  );
  return runs;
}

const done = { matched: 0, truncated: false };
const flush = () => new Promise((r) => setTimeout(r, 0));
const messages = () => vi.mocked(notifications.show).mock.calls.map((c) => c[0].message);

describe('matchQueue', () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks();
    client = new QueryClient();
  });

  it('is one queue per query client', () => {
    expect(matchQueueFor(client)).toBe(matchQueueFor(client));
    expect(matchQueueFor(client)).not.toBe(matchQueueFor(new QueryClient()));
  });

  it('runs one person at a time and reports progress to subscribers', async () => {
    const runs = deferredRuns();
    const queue = matchQueueFor(client);
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.enqueue('a');
    queue.enqueue('b');
    expect(runs.map((r) => r.id)).toEqual(['a']);
    expect(queue.getSnapshot()).toEqual({ current: { personId: 'a', scanned: 0, matched: 0 }, waiting: ['b'] });
    runs[0].onPage(100, 3);
    expect(queue.getSnapshot().current).toEqual({ personId: 'a', scanned: 100, matched: 3 });
    expect(listener).toHaveBeenCalled();
    runs[0].resolve(done);
    await flush();
    expect(runs.map((r) => r.id)).toEqual(['a', 'b']);
    runs[1].resolve(done);
    await flush();
    expect(queue.getSnapshot()).toEqual({ current: null, waiting: [] });
  });

  it('queues a person once, but again if their run has already started', async () => {
    const runs = deferredRuns();
    const queue = matchQueueFor(client);
    queue.enqueue('a');
    queue.enqueue('a');
    queue.enqueue('a');
    expect(queue.getSnapshot().waiting).toEqual(['a']);
    runs[0].resolve(done);
    await flush();
    runs[1].resolve(done);
    await flush();
    expect(runs).toHaveLength(2);
  });

  it('refreshes lists and announces matches when a run found some', async () => {
    const runs = deferredRuns();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    matchQueueFor(client).enqueue('a');
    runs[0].resolve({ matched: 2, truncated: true });
    await flush();
    expect(messages()).toEqual(['Matched 2 more faces', 'Stopped early, run Re-run matching to continue']);
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey?.[0]);
    expect(keys).toEqual(expect.arrayContaining(['photo-faces', 'people', 'people-groups', 'person-photos']));
  });

  it('does not refetch anything or notify when an automatic run found nothing', async () => {
    const runs = deferredRuns();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    matchQueueFor(client).enqueue('a');
    runs[0].resolve(done);
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
    expect(messages()).toEqual([]);
  });

  it('says so when a manual run found nothing, even if it joined a waiting run', async () => {
    const runs = deferredRuns();
    const queue = matchQueueFor(client);
    queue.enqueue('x');
    queue.enqueue('a');
    queue.enqueue('a', { manual: true });
    runs[0].resolve(done);
    await flush();
    runs[1].resolve(done);
    await flush();
    expect(messages()).toEqual(['No new matches']);
  });

  it('reports a failure, refreshes (pages may have been saved) and carries on', async () => {
    const runs = deferredRuns();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const queue = matchQueueFor(client);
    queue.enqueue('a');
    queue.enqueue('b', { manual: true });
    runs[0].reject(new Error('boom'));
    await flush();
    expect(messages()).toEqual(['Named, but could not look for more matches']);
    expect(invalidate).toHaveBeenCalled();
    runs[1].reject(new Error('boom'));
    await flush();
    expect(messages()[1]).toBe('Could not finish matching, try Re-run matching');
    expect(queue.getSnapshot().current).toBeNull();
  });

  it('refreshAfterNaming drops the named faces from the cached groups without requesting them again', () => {
    const faces = (...ids: string[]) => ({ faces: ids.map((id) => ({ id })) });
    client.setQueryData(['people-groups'], {
      pages: [{ groups: [faces('f1', 'f2'), faces('f3', 'f4')], scanned: 4, nextCursor: null }],
      pageParams: [undefined],
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    refreshAfterNaming(client, ['f1', 'f2', 'f3']);
    expect(client.getQueryData(['people-groups'])).toEqual({
      pages: [{ groups: [faces('f4')], scanned: 4, nextCursor: null }],
      pageParams: [undefined],
    });
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey?.[0]);
    expect(keys).toEqual(expect.arrayContaining(['people', 'photo-faces', 'search']));
    expect(keys).not.toContain('people-groups');
  });

  it('refreshAfterNaming is fine when no groups are cached', () => {
    refreshAfterNaming(client, ['f1']);
    expect(client.getQueryData(['people-groups'])).toBeUndefined();
  });
});
