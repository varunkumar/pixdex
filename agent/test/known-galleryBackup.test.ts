import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGallery, saveGallery, type Gallery } from '../src/known/gallery';
import { galleryChanged, pullGallery, pushGallery, restoreFromR2, type GalleryBackupClient } from '../src/known/galleryBackup';

const vec = (seed: number) => Float32Array.from({ length: 512 }, (_, i) => Math.sin(i + seed) + 2);
const gallery: Gallery = {
  model: 'buffalo_l',
  people: [
    { id: 'Q1', name: 'A', aliases: ['x'], refs: [vec(1), vec(2)] },
    { id: 'Q2', name: 'B', aliases: [], refs: [vec(3)] },
  ],
  excluded: [{ id: 'Q9', refs: 1 }],
};

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gallery-backup-'));
}

function fakeClient(stored?: Buffer): GalleryBackupClient & { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const put = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue(stored);
  return { putKnownGallery: put, getKnownGallery: get, put, get };
}

describe('pushGallery', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmp();
  });

  it('uploads the exact bytes of the saved file and returns the size', async () => {
    const file = path.join(dir, 'g.json');
    await saveGallery(file, gallery);
    const client = fakeClient();
    const size = await pushGallery(client, file);
    const bytes = await fs.readFile(file);
    expect(size).toBe(bytes.byteLength);
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(Buffer.from(client.put.mock.calls[0][0]).equals(bytes)).toBe(true);
  });

  it('throws when the file is missing and uploads nothing', async () => {
    const client = fakeClient();
    await expect(pushGallery(client, path.join(dir, 'none.json'))).rejects.toThrow(/no gallery file/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('refuses to push a corrupt file over the backup', async () => {
    const file = path.join(dir, 'g.json');
    const client = fakeClient();
    await fs.writeFile(file, '{not json');
    await expect(pushGallery(client, file)).rejects.toThrow(/refusing to push/);
    await fs.writeFile(file, JSON.stringify({ model: 1 }));
    await expect(pushGallery(client, file)).rejects.toThrow(/refusing to push/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('refuses a file that loads but has no people, or no model string', async () => {
    const file = path.join(dir, 'g.json');
    const client = fakeClient();
    await fs.writeFile(file, JSON.stringify({ model: 'm', people: [] }));
    await expect(pushGallery(client, file)).rejects.toThrow(/refusing to push/);
    await fs.writeFile(file, JSON.stringify({ model: 1, people: [{ id: 'p', name: 'P', aliases: [], refs: [] }] }));
    await expect(pushGallery(client, file)).rejects.toThrow(/refusing to push/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('propagates an upload failure', async () => {
    const file = path.join(dir, 'g.json');
    await saveGallery(file, gallery);
    const client = fakeClient();
    client.put.mockRejectedValue(new Error('put failed: 500'));
    await expect(pushGallery(client, file)).rejects.toThrow(/500/);
  });
});

describe('restoreFromR2', () => {
  let dir: string;
  let source: string;
  beforeEach(async () => {
    dir = await tmp();
    source = path.join(dir, 'src.json');
    await saveGallery(source, gallery);
  });

  it('writes a valid R2 object to the local path and returns the loaded gallery', async () => {
    const stored = await fs.readFile(source);
    const file = path.join(dir, 'nested', 'g.json');
    const got = await restoreFromR2(fakeClient(stored), file);
    expect(got?.model).toBe('buffalo_l');
    expect(got?.people.map((p) => p.id)).toEqual(['Q1', 'Q2']);
    expect((await loadGallery(file))?.excluded).toEqual([{ id: 'Q9', refs: 1 }]);
    expect((await fs.readFile(file)).equals(stored)).toBe(true);
    expect(await fs.readdir(path.join(dir, 'nested'))).toEqual(['g.json']);
  });

  it('returns undefined and writes nothing when R2 has no object', async () => {
    const file = path.join(dir, 'g.json');
    expect(await restoreFromR2(fakeClient(undefined), file)).toBeUndefined();
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('rejects a corrupt object with a warning, writes nothing and leaves an existing file alone', async () => {
    const file = path.join(dir, 'g.json');
    await fs.writeFile(file, 'keep me');
    const warn = vi.fn();
    for (const bad of ['{not json', JSON.stringify({ model: 'm', people: [{ id: 'p', name: 'P', aliases: [], refs: ['AAAA'] }] }), '[]']) {
      expect(await restoreFromR2(fakeClient(Buffer.from(bad)), file, warn)).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain('unreadable');
    expect(await fs.readFile(file, 'utf8')).toBe('keep me');
    expect((await fs.readdir(dir)).sort()).toEqual(['g.json', 'src.json']);
  });

  it('does not blame R2 for a local filesystem failure', async () => {
    const stored = await fs.readFile(source);
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'a file, not a directory');
    const warn = vi.fn();
    expect(await restoreFromR2(fakeClient(stored), path.join(blocker, 'g.json'), warn)).toBeUndefined();
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('Could not write');
    expect(message).not.toContain('in R2 is unreadable');
  });

  it('propagates a failing R2 read', async () => {
    const client = fakeClient();
    client.get.mockRejectedValue(new Error('get failed: 500'));
    await expect(restoreFromR2(client, path.join(dir, 'g.json'))).rejects.toThrow(/500/);
  });
});

describe('pullGallery', () => {
  it('refuses to overwrite an existing file without force, without calling R2', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'g.json');
    await fs.writeFile(file, 'local');
    const client = fakeClient(Buffer.from('x'));
    expect(await pullGallery(client, file, { force: false })).toEqual({ status: 'exists' });
    expect(client.get).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('local');
  });

  it('overwrites with force and pulls when no file exists', async () => {
    const dir = await tmp();
    const source = path.join(dir, 'src.json');
    await saveGallery(source, gallery);
    const stored = await fs.readFile(source);
    const file = path.join(dir, 'g.json');
    await fs.writeFile(file, 'old');
    const forced = await pullGallery(fakeClient(stored), file, { force: true });
    expect(forced.status).toBe('pulled');
    expect((await fs.readFile(file)).equals(stored)).toBe(true);
    await fs.rm(file);
    expect((await pullGallery(fakeClient(stored), file, { force: false })).status).toBe('pulled');
  });

  it('reports absent when R2 has nothing', async () => {
    const dir = await tmp();
    expect(await pullGallery(fakeClient(undefined), path.join(dir, 'g.json'), { force: false })).toEqual({ status: 'absent' });
  });
});

describe('galleryChanged', () => {
  const same = (g: Gallery): Gallery => ({ ...g, people: g.people.map((p) => ({ ...p })) });

  it('is false for the same people reusing their refs, true for everything else', () => {
    expect(galleryChanged(gallery, same(gallery))).toBe(false);
    expect(galleryChanged(undefined, gallery)).toBe(true);
    expect(galleryChanged({ ...gallery, model: 'other' }, gallery)).toBe(true);
    expect(galleryChanged(gallery, { ...gallery, people: gallery.people.slice(1) })).toBe(true);
    const recomputed = same(gallery);
    recomputed.people[0] = { ...recomputed.people[0], refs: [vec(9)] };
    expect(galleryChanged(gallery, recomputed)).toBe(true);
    const renamed = same(gallery);
    renamed.people[1] = { ...renamed.people[1], name: 'Bee' };
    expect(galleryChanged(gallery, renamed)).toBe(true);
    const realiased = same(gallery);
    realiased.people[0] = { ...realiased.people[0], aliases: ['y'] };
    expect(galleryChanged(gallery, realiased)).toBe(true);
    expect(galleryChanged(gallery, { ...same(gallery), excluded: [] })).toBe(true);
  });
});
