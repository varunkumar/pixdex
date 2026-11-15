import { describe, expect, it } from 'vitest';
import { parseSpeciesArgs } from '../src/species/args';

describe('parseSpeciesArgs', () => {
  it('has sensible defaults', () => {
    expect(parseSpeciesArgs([])).toEqual({ albums: [], list: false, dryRun: false });
  });

  it('reads flags, repeated albums and a limit', () => {
    expect(parseSpeciesArgs(['--list', '--dry-run', '--album', 'Bandipur (2025)', '--album', 'Kanha', '--limit', '200'])).toEqual({
      albums: ['Bandipur (2025)', 'Kanha'],
      list: true,
      dryRun: true,
      limit: 200,
    });
  });

  it('rejects unknown flags, a missing value and a bad limit', () => {
    expect(parseSpeciesArgs(['--nope'])).toEqual({ error: 'Unknown argument: --nope' });
    expect(parseSpeciesArgs(['--album'])).toEqual({ error: '--album needs an album name' });
    expect(parseSpeciesArgs(['--limit', 'x'])).toEqual({ error: '--limit needs a positive whole number' });
    expect(parseSpeciesArgs(['--limit', '0'])).toEqual({ error: '--limit needs a positive whole number' });
  });
});
