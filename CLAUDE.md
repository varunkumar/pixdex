@AGENTS.md

## Performance review is mandatory (CPU and DB)

Every change, feature or fix MUST explicitly review and optimize for Worker CPU
and D1 usage, and the result must be stated in your plan and your summary. This
is not optional and not only for "performance tasks".

- Worker CPU: the free plan allows 10 ms CPU per invocation. Flag any new loop
  over embeddings, JSON parse or stringify of large payloads, base64 or blob
  decoding, per-item allocations, or work that scales with table size. Bound it
  (page size, budget, cache) or move it off the Worker.
- D1: state the rows read and written per request. Check that new queries use an
  index (`EXPLAIN QUERY PLAN`), avoid unbounded scans, `OFFSET` paging,
  `COUNT(*)` on every request, and N+1 query patterns. Prefer set-based
  statements and `json_each` batching. New indexes and tables go in an additive
  numbered migration.
- If a change adds cost, say how much and why it is worth it. If it cannot be
  measured locally, say so and list how to measure it (`wrangler tail`,
  `wrangler d1 insights`, see `TODO.todo` and `docs/development.md`).
- Do not ship a change that raises CPU or rows read on a hot path without
  telling the user first.
