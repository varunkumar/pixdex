// Pure helpers for seed-access.mjs (no Node imports, so the Worker test pool can load them).
import { normalizeOwnerEmail } from './backfill-owner-lib.mjs';

const EXPECTED_COUNT = 2;

function cleanEmail(raw, where) {
  if (typeof raw !== 'string') throw new Error(`${where}: expected an email string, got ${JSON.stringify(raw)}`);
  try {
    return normalizeOwnerEmail(raw);
  } catch {
    throw new Error(`${where}: not a valid email address: ${JSON.stringify(raw)}`);
  }
}

function sharedEmails(shared) {
  let list;
  try {
    list = JSON.parse(shared);
  } catch {
    throw new Error(`albums.shared_with is not valid JSON: ${JSON.stringify(shared)}`);
  }
  if (!Array.isArray(list)) throw new Error(`albums.shared_with is not a JSON array: ${JSON.stringify(shared)}`);
  return list.map((e) => cleanEmail(e, 'albums.shared_with'));
}

/**
 * Collects the distinct lowercase emails from album owners, shared_with arrays and the admin.
 * Throws unless there are exactly 2 (a different count means stop and ask the owner).
 * Every address is validated to carry no quote, so the SQL literal is safe. `nowIso` is injected for tests.
 */
export function planSeed(rows, adminEmail, nowIso) {
  const set = new Set([cleanEmail(adminEmail, 'ADMIN_EMAIL')]);
  for (const row of rows) {
    if (row.owner != null) set.add(cleanEmail(row.owner, 'albums.owner_email'));
    if (row.shared != null) for (const e of sharedEmails(row.shared)) set.add(e);
  }
  const emails = [...set].sort();
  if (emails.length !== EXPECTED_COUNT) {
    throw new Error(`Expected exactly ${EXPECTED_COUNT} distinct addresses, found ${emails.length}: ${emails.join(', ')}. Stop and ask the owner.`);
  }
  if (typeof nowIso !== 'string' || !/^[0-9T:.\-Z+]+$/.test(nowIso)) throw new Error(`Invalid timestamp: ${JSON.stringify(nowIso)}`);
  const values = emails.map((e) => `('${e}', 'approved', '${nowIso}', '${nowIso}')`).join(', ');
  // Upsert: a person who enrolled (pending) before the seed ran becomes approved; an existing approved,
  // denied or revoked row is left untouched, so a second run changes nothing.
  return {
    emails,
    sql:
      `INSERT INTO access_requests (email, status, created_at, decided_at) VALUES ${values} ` +
      `ON CONFLICT(email) DO UPDATE SET status = 'approved', decided_at = excluded.decided_at WHERE access_requests.status = 'pending';`,
  };
}

/** Parses `wrangler d1 execute --json` output: a list of result objects, each with a `results` array. */
export function parseWranglerRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Unexpected wrangler output: not JSON');
  }
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!first || !Array.isArray(first.results)) throw new Error('Unexpected wrangler output: no results array in the first result object');
  return first.results;
}
