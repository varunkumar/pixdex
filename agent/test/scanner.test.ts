import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isImageFile, scanDirectory } from '../src/scanner';

describe('isImageFile', () => {
  it('accepts common image extensions', () => {
    expect(isImageFile('leopard.jpg')).toBe(true);
    expect(isImageFile('leopard.PNG')).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(isImageFile('notes.txt')).toBe(false);
  });

  it('rejects macOS resource-fork files', () => {
    expect(isImageFile('._leopard.jpg')).toBe(false);
  });
});

describe('scanDirectory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-scan-'));
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'a.jpg'), 'x');
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    await writeFile(path.join(dir, 'sub', 'b.png'), 'x');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds files recursively, including nested folders', async () => {
    const files = await scanDirectory(dir);
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith('sub/b.png'))).toBe(true);
  });
});
