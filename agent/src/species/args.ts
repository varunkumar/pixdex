export interface SpeciesArgs {
  albums: string[];
  list: boolean;
  dryRun: boolean;
  limit?: number;
}

/** Parses `backfill-species [--list] [--dry-run] [--album <name>]... [--limit <n>]`. */
export function parseSpeciesArgs(args: string[]): SpeciesArgs | { error: string } {
  const out: SpeciesArgs = { albums: [], list: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list') out.list = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--album') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { error: '--album needs an album name' };
      out.albums.push(v);
    } else if (a === '--limit') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) return { error: '--limit needs a positive whole number' };
      out.limit = n;
    } else return { error: `Unknown argument: ${a}` };
  }
  return out;
}
