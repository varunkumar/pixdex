import type { QueryClient } from '@tanstack/react-query';

/** People whose review pages were gone through to the end. Browser memory only, lost on a page reload. */
const finished = new WeakMap<QueryClient, Set<string>>();

export const finishedReviews = (client: QueryClient): ReadonlySet<string> => finished.get(client) ?? new Set();

export function noteReviewFinished(client: QueryClient, personId: string) {
  finished.set(client, new Set(finishedReviews(client)).add(personId));
}
