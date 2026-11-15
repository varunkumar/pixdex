#!/usr/bin/env node
// One-time rollout step: seeds access_requests with the people who keep access when the Cloudflare Access
// policy changes from "any Google account" to the approved group (the group itself is filled by hand).
// Usage (from worker/): npm run seed-access [-- --local] [-- --dry-run]
// ADMIN_EMAIL (the same address as OWNER_EMAIL) comes from the environment or ../agent/.env. Idempotent.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './backfill-owner-args.mjs';
import { ownerEmailFromDotenv, normalizeOwnerEmail } from './backfill-owner-lib.mjs';
import { parseWranglerRows, planSeed } from './seed-access-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, '..');
const dotenvPath = resolve(workerDir, '../agent/.env');
const parsed = parseArgs(process.argv.slice(2));
if ('error' in parsed) {
  console.error(parsed.error.replace('backfill-owner', 'seed-access'));
  process.exit(2);
}
const { local, dryRun } = parsed;
const target = local ? '--local' : '--remote';

try {
  const dotenv = existsSync(dotenvPath) ? readFileSync(dotenvPath, 'utf8') : '';
  const admin = normalizeOwnerEmail(process.env.ADMIN_EMAIL?.trim() ? process.env.ADMIN_EMAIL : process.env.OWNER_EMAIL?.trim() ? process.env.OWNER_EMAIL : ownerEmailFromDotenv(dotenv));

  const read = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'DB', target, '--json', '--command', 'SELECT owner_email AS owner, shared_with AS shared FROM albums WHERE owner_email IS NOT NULL OR shared_with IS NOT NULL'],
    { cwd: workerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }
  );
  const { emails, sql } = planSeed(parseWranglerRows(read), admin, new Date().toISOString());

  console.log(`${local ? 'Local' : 'Remote'} D1: approving ${emails.join(', ')}`);
  console.log(sql);
  if (dryRun) {
    console.log('(dry run) nothing executed');
    process.exit(0);
  }
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--command', sql], { cwd: workerDir, stdio: 'inherit' });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
