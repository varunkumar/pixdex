import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveAlbum } from '../src/moveAlbum';
import { runMoveAlbum } from '../src/moveAlbumCli';
import type { CloudflareClient } from '../src/cloudflareClient';

describe('moveAlbum', () => {
  let root: string;
  let from: string;
  let to: string;
  let relocatePhotos: ReturnType<typeof vi.fn>;
  let client: CloudflareClient;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pixdex-move-'));
    from = path.join(root, 'abc');
    to = path.join(root, 'xyz');
    await mkdir(path.join(from, 'sub'), { recursive: true });
    await writeFile(path.join(from, '1.jpg'), 'one');
    await writeFile(path.join(from, 'sub', '2.jpg'), 'two');
    relocatePhotos = vi.fn(async (_f: string, _t: string, dryRun?: boolean) => ({ matched: 2, updated: dryRun ? 0 : 2 }));
    client = { relocatePhotos } as unknown as CloudflareClient;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('renames the folder and re-points the index', async () => {
    const result = await moveAlbum(from, to, { cloudflareClient: client });

    expect(await readFile(path.join(to, 'sub', '2.jpg'), 'utf8')).toBe('two');
    await expect(stat(from)).rejects.toThrow();
    expect(relocatePhotos).toHaveBeenLastCalledWith(from, to);
    expect(result).toEqual({ photos: 2, files: 0, movedOnDisk: true });
  });

  it('dry run changes nothing', async () => {
    const result = await moveAlbum(from, to, { cloudflareClient: client }, { dryRun: true });

    expect((await stat(from)).isDirectory()).toBe(true);
    await expect(stat(to)).rejects.toThrow();
    expect(relocatePhotos).toHaveBeenCalledTimes(1);
    expect(relocatePhotos).toHaveBeenCalledWith(from, to, true);
    expect(result).toEqual({ photos: 2, files: 0, movedOnDisk: false });
  });

  it('index-only leaves the disk alone', async () => {
    await mkdir(to);
    const result = await moveAlbum(from, to, { cloudflareClient: client }, { indexOnly: true });

    expect((await stat(from)).isDirectory()).toBe(true);
    expect(relocatePhotos).toHaveBeenLastCalledWith(from, to);
    expect(result.movedOnDisk).toBe(false);
  });

  it('refuses an existing destination, a missing source, and nested folders', async () => {
    await mkdir(to);
    await expect(moveAlbum(from, to, { cloudflareClient: client })).rejects.toThrow('already exists');
    await expect(moveAlbum(path.join(root, 'nope'), path.join(root, 'new'), { cloudflareClient: client })).rejects.toThrow('not found');
    await expect(moveAlbum(from, path.join(from, 'inner'), { cloudflareClient: client })).rejects.toThrow('inside one another');
    await expect(moveAlbum(from, from, { cloudflareClient: client })).rejects.toThrow('same folder');
    expect(relocatePhotos).not.toHaveBeenCalled();
  });

  it('tells you to re-run with --index-only when the index update fails after the move', async () => {
    relocatePhotos.mockImplementation(async (_f: string, _t: string, dryRun?: boolean) => {
      if (dryRun) return { matched: 2, updated: 0 };
      throw new Error('ingest/relocate failed: 500');
    });

    await expect(moveAlbum(from, to, { cloudflareClient: client })).rejects.toThrow('--index-only');
    expect((await stat(to)).isDirectory()).toBe(true);
  });

  it('CLI prints usage for missing or unknown arguments', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMoveAlbum([from])).toBe(1);
    expect(await runMoveAlbum([from, to, '--force'])).toBe(1);
    error.mockRestore();
  });
});
