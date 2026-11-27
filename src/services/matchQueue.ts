import { notifications } from '@mantine/notifications';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { FaceGroupsResponse } from '../types/api';
import { workerApiClient } from './api/WorkerApiClient';
import { matchedMessage, SEARCH_KEYS, TRUNCATED_MESSAGE } from './peopleKeys';

export interface MatchSnapshot {
  current: { personId: string; scanned: number; matched: number } | null;
  /** Person ids still to be matched, in order. */
  waiting: string[];
}

export interface MatchQueue {
  /** `manual` is the Re-run matching button: it also reports a run that found nothing. */
  enqueue(personId: string, opts?: { manual?: boolean }): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): MatchSnapshot;
}

const invalidate = (client: QueryClient, keys: string[]) => {
  for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
};

/** After matching has written faces: everything that shows people or faces is out of date. */
const refreshAfterMatching = (client: QueryClient) => invalidate(client, ['photo-faces', 'people', ...SEARCH_KEYS]);

/**
 * Right after faces are named. The named faces are removed from the cached unnamed groups instead of refetching
 * them, so a confirmation does not re-request every loaded group page before matching has even run.
 */
export function refreshAfterNaming(client: QueryClient, faceIds: string[]) {
  const named = new Set(faceIds);
  client.setQueryData<InfiniteData<FaceGroupsResponse>>(['people-groups'], (data) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        groups: page.groups
          .map((g) => ({ faces: g.faces.filter((f) => !named.has(f.id)) }))
          .filter((g) => g.faces.length > 0),
      })),
    }
  );
  invalidate(client, ['photo-faces', 'people', ...SEARCH_KEYS.filter((k) => k !== 'people-groups')]);
}

/**
 * Matches people against the unnamed faces in the background, one person at a time (parallel runs would only
 * compete for the same faces and multiply the load on the Worker). It lives outside React so it carries on when
 * the user changes page; closing the tab stops it.
 */
function createMatchQueue(client: QueryClient): MatchQueue {
  const pending: { personId: string; manual: boolean }[] = [];
  const listeners = new Set<() => void>();
  let current: MatchSnapshot['current'] = null;
  let snapshot: MatchSnapshot = { current: null, waiting: [] };

  const emit = () => {
    snapshot = { current, waiting: pending.map((j) => j.personId) };
    for (const listener of listeners) listener();
  };

  const run = async (job: { personId: string; manual: boolean }) => {
    try {
      const { matched, truncated } = await workerApiClient.matchPersonAll(job.personId, (scanned, found) => {
        current = { personId: job.personId, scanned, matched: found };
        emit();
      });
      if (matched > 0) {
        notifications.show({ message: matchedMessage(matched) });
        refreshAfterMatching(client);
      } else if (job.manual) notifications.show({ message: 'No new matches' });
      if (truncated) notifications.show({ message: TRUNCATED_MESSAGE });
    } catch {
      // For an automatic run the faces are already named; this must not read as a naming failure.
      notifications.show({
        color: 'red',
        message: job.manual
          ? 'Could not finish matching, try Re-run matching'
          : 'Named, but could not look for more matches',
      });
      // Earlier pages may already have been saved.
      refreshAfterMatching(client);
    }
  };

  const drain = async () => {
    for (let job = pending.shift(); job; job = pending.shift()) {
      current = { personId: job.personId, scanned: 0, matched: 0 };
      emit();
      await run(job);
    }
    current = null;
    emit();
  };

  return {
    enqueue(personId, { manual = false } = {}) {
      // A waiting run will already see the newest confirmed faces. A started one may not, so queue another.
      const waiting = pending.find((j) => j.personId === personId);
      if (waiting) {
        waiting.manual ||= manual;
        return;
      }
      pending.push({ personId, manual });
      if (current) emit();
      else void drain();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

const queues = new WeakMap<QueryClient, MatchQueue>();

export function matchQueueFor(client: QueryClient): MatchQueue {
  let queue = queues.get(client);
  if (!queue) {
    queue = createMatchQueue(client);
    queues.set(client, queue);
  }
  return queue;
}
