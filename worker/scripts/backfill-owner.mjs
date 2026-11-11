#!/usr/bin/env node
// One-time rollout step: stamps every album and person that has no owner with OWNER_EMAIL.
// Usage (from worker/): npm run backfill-owner [-- --local] [-- --dry-run]
// OWNER_EMAIL comes from the environment or ../agent/.env. Idempotent: rows that already have an owner are untouched.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './backfill-owner-args.mjs';
import { buildBackfillSql, resolveOwnerEmail } from './backfill-owner-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, '..');
const dotenvPath = resolve(workerDir, '../agent/.env');
const parsed = parseArgs(process.argv.slice(2));
if ('error' in parsed) {
  console.error(parsed.error);
  process.exit(2);
}
const { local, dryRun } = parsed;

let email;
try {
  email = resolveOwnerEmail(process.env, existsSync(dotenvPath) ? readFileSync(dotenvPath, 'utf8') : '');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const sql = buildBackfillSql(email);
const wranglerArgs = ['wrangler', 'd1', 'execute', 'DB', local ? '--local' : '--remote', '--command', sql];
console.log(`${local ? 'Local' : 'Remote'} D1: stamping unowned albums and people with ${email}`);
if (dryRun) {
  console.log(sql);
  console.log(`(dry run) npx ${wranglerArgs.join(' ')}`);
  process.exit(0);
}
execFileSync('npx', wranglerArgs, { cwd: workerDir, stdio: 'inherit' });
