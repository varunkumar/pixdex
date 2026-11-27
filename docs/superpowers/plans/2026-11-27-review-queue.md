# "To review" page Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-27-review-queue-design.md`. Executed in one session, test first.

1. Worker: `REVIEW_QUEUE_SQL` and `reviewQueueRoute` in `worker/src/routes/people.ts`, `GET /people/review-queue`,
   proxy GET allowlist. Tests: `worker/test/review-queue.test.ts`, plan in `query-plans.test.ts`, `proxy.test.ts`.
2. Frontend: `getReviewQueue`, `useReviewQueue` (query key `['people', 'review-queue']`, so every people
   invalidation refreshes it), `ReviewQueue.tsx` at `/review`, People page link, "All to review" and "Next" on the
   review grid (`services/reviewVisit.ts` remembers finished people). Tests beside the components.
3. Mock API, `README.md`, `AGENTS.md`, `docs/`, measured D1 cost.

Global constraints: no migration or index; no writes; Search, Timeline and the navigation do not request the queue.
