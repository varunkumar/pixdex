/** Parses CLI args: only --local and --dry-run are accepted. Returns { error } for anything else. */
export function parseArgs(argv) {
  const out = { local: false, dryRun: false };
  for (const a of argv) {
    if (a === '--local') out.local = true;
    else if (a === '--dry-run') out.dryRun = true;
    else return { error: `Unknown argument: ${a}\nUsage: npm run backfill-owner [-- --local] [-- --dry-run]` };
  }
  return out;
}
