import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256ContentHash } from '../src/hashing';

describe('sha256ContentHash', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-hash-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a 64-char lowercase hex digest', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'hello world');
    const hash = await sha256ContentHash(file);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for identical content', async () => {
    const fileA = path.join(dir, 'a.txt');
    const fileB = path.join(dir, 'b.txt');
    await writeFile(fileA, 'same content');
    await writeFile(fileB, 'same content');
    expect(await sha256ContentHash(fileA)).toBe(await sha256ContentHash(fileB));
  });

  it('differs for different content', async () => {
    const fileA = path.join(dir, 'a.txt');
    const fileB = path.join(dir, 'b.txt');
    await writeFile(fileA, 'content one');
    await writeFile(fileB, 'content two');
    expect(await sha256ContentHash(fileA)).not.toBe(await sha256ContentHash(fileB));
  });
});
