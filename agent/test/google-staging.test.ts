import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STAGING_MAX_BYTES, stagingLimitBytes, sweepStaleStaging } from '../src/google/staging';

describe('stagingLimitBytes', () => {
  it('defaults to 1 GB and honours DRIVE_STAGING_MAX_MB', () => {
    expect(stagingLimitBytes(undefined)).toBe(DEFAULT_STAGING_MAX_BYTES);
    expect(DEFAULT_STAGING_MAX_BYTES).toBe(1024 ** 3);
    expect(stagingLimitBytes(200)).toBe(200 * 1024 * 1024);
    expect(stagingLimitBytes(0)).toBe(DEFAULT_STAGING_MAX_BYTES);
  });
});

describe('sweepStaleStaging', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-staging-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function make(name: string, ageMs: number): Promise<void> {
    const file = path.join(dir, name);
    await writeFile(file, 'x'.repeat(10));
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }

  it('removes only old pixdex-drive files, leaving fresh ones and anything else alone', async () => {
    await make('pixdex-drive-old.jpg', 2 * 60 * 60 * 1000);
    await make('pixdex-drive-fresh.jpg', 60 * 1000);
    await make('unrelated-old.txt', 5 * 60 * 60 * 1000);

    const result = await sweepStaleStaging(dir);

    expect(result).toEqual({ removed: 1, bytes: 10 });
    expect((await readdir(dir)).sort()).toEqual(['pixdex-drive-fresh.jpg', 'unrelated-old.txt']);
  });

  it('creates a missing folder and never throws', async () => {
    const missing = path.join(dir, 'nested', 'staging');
    await expect(sweepStaleStaging(missing)).resolves.toEqual({ removed: 0, bytes: 0 });
    await expect(sweepStaleStaging('/proc/definitely/not/writable\0bad')).resolves.toEqual({ removed: 0, bytes: 0 });
  });
});
