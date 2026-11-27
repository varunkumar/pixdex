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
  /**
   * `manual` is the Re-run matching button: it checks every candidate and also reports a run that found nothing.
   * Otherwise the run checks unnamed faces and the auto matches of the people in `from`.
   */
  enqueue(personId: string, opts?: { manual?: boolean; from?: string[] }): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): MatchSnapshot;
}

const invalidate = (client: QueryClient, keys: string[]) => {
  for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
};

/** Marks the review counts out of date without requesting them now: the Worker reads every pending face. */
export function markReviewQueueStale(client: QueryClient) {
  void client.invalidateQueries({ queryKey: ['review-queue'], refetchType: 'none' });
}

/** After matching has written faces: everything that shows people or faces is out of date. */
const refreshAfterMatching = (client: QueryClient) => {
  markReviewQueueStale(client);
  invalidate(client, ['photo-faces', 'person-faces', 'people', ...SEARCH_KEYS]);
};

/**
 * Removes faces from the cached unnamed groups instead of refetching them, so naming or ignoring does not
 * re-request every loaded group page.
 */
function dropFromGroups(client: QueryClient, faceIds: string[]) {
  const gone = new Set(faceIds);
  client.setQueryData<InfiniteData<FaceGroupsResponse>>(['people-groups'], (data) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        groups: page.groups
          .map((g) => ({ faces: g.faces.filter((f) => !gone.has(f.id)) }))
          .filter((g) => g.faces.length > 0),
      })),
    }
  );
}

const SEARCH_KEYS_BUT_GROUPS = SEARCH_KEYS.filter((k) => k !== 'people-groups');

/** Right after faces are named, before matching has even run. */
export function refreshAfterNaming(client: QueryClient, faceIds: string[]) {
  dropFromGroups(client, faceIds);
  markReviewQueueStale(client);
  invalidate(client, ['photo-faces', 'person-faces', 'people', ...SEARCH_KEYS_BUT_GROUPS]);
}

/** Ignoring also hides a face's known-personality match, so known lists and searches change too. */
const IGNORE_KEYS = ['ignored-faces', 'photo-faces', 'person-faces', 'known-people', 'album-contents'];

export function refreshAfterIgnoring(client: QueryClient, faceIds: string[]) {
  dropFromGroups(client, faceIds);
  invalidate(client, [...IGNORE_KEYS, ...SEARCH_KEYS_BUT_GROUPS]);
}

/** Restored faces come back into the unnamed groups, which only the Worker can rebuild. */
export function refreshAfterRestoring(client: QueryClient) {
  invalidate(client, [...IGNORE_KEYS, ...SEARCH_KEYS]);
}

/** After auto matches were confirmed or rejected: rejected faces also leave counts and rejoin the unnamed groups. */
export function refreshAfterReview(client: QueryClient) {
  markReviewQueueStale(client);
  invalidate(client, ['photo-faces', 'person-faces', 'people', 'album-contents', ...SEARCH_KEYS]);
}

/** The Worker's limit on `from`. */
const MAX_FROM = 50;

interface Job {
  personId: string;
  manual: boolean;
  from: Set<string>;
}

/**
 * Matches people against the unnamed faces in the background, one person at a time (parallel runs would only
 * compete for the same faces and multiply the load on the Worker). It lives outside React so it carries on when
 * the user changes page; closing the tab stops it.
 */
function createMatchQueue(client: QueryClient): MatchQueue {
  const pending: Job[] = [];
  const listeners = new Set<() => void>();
  let current: MatchSnapshot['current'] = null;
  let snapshot: MatchSnapshot = { current: null, waiting: [] };

  const emit = () => {
    snapshot = { current, waiting: pending.map((j) => j.personId) };
    for (const listener of listeners) listener();
  };

  const run = async (job: Job) => {
    try {
      const { matched, truncated } = await workerApiClient.matchPersonAll(
        job.personId,
        (scanned, found) => {
          current = { personId: job.personId, scanned, matched: found };
          emit();
        },
        job.manual ? undefined : [...job.from].slice(0, MAX_FROM)
      );
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
    enqueue(personId, { manual = false, from = [] } = {}) {
      // A waiting run will already see the newest confirmed faces. A started one may not, so queue another.
      const waiting = pending.find((j) => j.personId === personId);
      if (waiting) {
        waiting.manual ||= manual;
        for (const id of from) waiting.from.add(id);
        return;
      }
      pending.push({ personId, manual, from: new Set(from) });
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

/** Face id to the people it was removed from, until it is named again. Lost on a page reload. */
const removedNames = new WeakMap<QueryClient, Map<string, Set<string>>>();

/** "Not X" or "Remove name": remembered so that naming the face next also re-checks X's automatic matches. */
export function noteRemovedName(client: QueryClient, faceId: string, personId: string) {
  const faces = removedNames.get(client) ?? new Map<string, Set<string>>();
  removedNames.set(client, faces);
  faces.set(faceId, (faces.get(faceId) ?? new Set<string>()).add(personId));
}

/** After faces are named: look for more of that person in the background. */
export function matchAfterNaming(client: QueryClient, personId: string, faceIds: string[]) {
  const faces = removedNames.get(client);
  const from = new Set<string>();
  for (const faceId of faceIds) {
    for (const id of faces?.get(faceId) ?? []) from.add(id);
    faces?.delete(faceId);
  }
  from.delete(personId);
  matchQueueFor(client).enqueue(personId, { from: [...from] });
}
