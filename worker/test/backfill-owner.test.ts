import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without type declarations
import { buildBackfillSql, normalizeOwnerEmail, ownerEmailFromDotenv, resolveOwnerEmail } from '../scripts/backfill-owner-lib.mjs';

describe('backfill-owner helpers', () => {
  it('lowercases and trims a valid email', () => {
    expect(normalizeOwnerEmail('  Me@Example.COM ')).toBe('me@example.com');
  });

  it('rejects empty, malformed and quote-carrying values', () => {
    for (const bad of ['', '   ', undefined, 'no-at', "a'b@example.com", 'a@b.co; DROP TABLE albums', 'a b@example.com', 'a@b"c.com']) {
      expect(() => normalizeOwnerEmail(bad)).toThrow();
    }
  });

  it('parses OWNER_EMAIL from dotenv text', () => {
    expect(ownerEmailFromDotenv('A=1\nOWNER_EMAIL=me@example.com\nB=2')).toBe('me@example.com');
    expect(ownerEmailFromDotenv('# OWNER_EMAIL=old@example.com\nexport OWNER_EMAIL="Me@Example.com"  # mine')).toBe('Me@Example.com');
    expect(ownerEmailFromDotenv('OWNER_EMAIL=x@example.com # note')).toBe('x@example.com');
    expect(ownerEmailFromDotenv('OTHER=1')).toBeUndefined();
  });

  it('prefers the environment over the dotenv file', () => {
    expect(resolveOwnerEmail({ OWNER_EMAIL: 'env@example.com' }, 'OWNER_EMAIL=file@example.com')).toBe('env@example.com');
    expect(resolveOwnerEmail({}, 'OWNER_EMAIL=File@example.com')).toBe('file@example.com');
    expect(() => resolveOwnerEmail({}, '')).toThrow(/not set/);
  });

  it('builds SQL that only stamps unowned rows, and running it twice changes nothing more', async () => {
    const sql = buildBackfillSql('Me@Example.com') as string;
    expect(sql).toBe(
      "UPDATE albums SET owner_email = 'me@example.com' WHERE owner_email IS NULL; UPDATE persons SET owner_email = 'me@example.com' WHERE owner_email IS NULL;"
    );
    await env.DB.prepare('DELETE FROM persons').run();
    await env.DB.prepare('DELETE FROM albums').run();
    await env.DB.prepare("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('n', 'Null', NULL, 'x'), ('o', 'Owned', 'o@example.com', 'x')").run();
    const [a, b] = sql.split('; ').map((x) => (x.endsWith(';') ? x : `${x};`));
    for (const stmt of [a, b, a, b]) await env.DB.prepare(stmt).run();
    const rows = await env.DB.prepare('SELECT id, owner_email FROM persons ORDER BY id').all();
    expect(rows.results).toEqual([
      { id: 'n', owner_email: 'me@example.com' },
      { id: 'o', owner_email: 'o@example.com' },
    ]);
  });
});
