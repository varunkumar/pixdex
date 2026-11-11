// Pure helpers for backfill-owner.mjs (no Node imports, so the Worker test pool can load them).

const EMAIL = /^[^\s@'"`;\\]+@[^\s@'"`;\\]+\.[^\s@'"`;\\]+$/;

/** Validates and lowercases an owner email. Throws when it is not a plain address (so it cannot carry SQL). */
export function normalizeOwnerEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email) throw new Error('OWNER_EMAIL is not set (environment or agent/.env)');
  if (email.length > 254 || !EMAIL.test(email)) throw new Error(`OWNER_EMAIL is not a valid email address: ${JSON.stringify(email)}`);
  return email;
}

/** Reads OWNER_EMAIL from dotenv text: KEY=value lines, # comments, optional quotes and `export`. */
export function ownerEmailFromDotenv(text) {
  let found;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?OWNER_EMAIL\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[1];
    const q = v.match(/^(['"])(.*)\1/);
    v = q ? q[2] : v.replace(/\s+#.*$/, '');
    found = v;
  }
  return found;
}

/** The environment value wins over the dotenv file. */
export function resolveOwnerEmail(env, dotenvText) {
  return normalizeOwnerEmail(env.OWNER_EMAIL?.trim() ? env.OWNER_EMAIL : ownerEmailFromDotenv(dotenvText));
}

/** Idempotent: only rows with no owner are stamped. The email is validated to contain no quote, so it is safe inside a SQL literal. */
export function buildBackfillSql(email) {
  const e = normalizeOwnerEmail(email);
  return `UPDATE albums SET owner_email = '${e}' WHERE owner_email IS NULL; UPDATE persons SET owner_email = '${e}' WHERE owner_email IS NULL;`;
}
