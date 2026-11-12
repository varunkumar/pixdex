import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeEmbedding, GALLERY_PATH, loadGallery, saveGallery } from '../src/known/gallery';

function b64(floats: number[]): string {
  return Buffer.from(new Float32Array(floats).buffer).toString('base64');
}

describe('decodeEmbedding', () => {
  it('decodes 512 floats and L2-normalises', () => {
    const v = decodeEmbedding(b64(Array.from({ length: 512 }, () => 2)));
    expect(v).toHaveLength(512);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });
  it('rejects the wrong length', () => {
    expect(() => decodeEmbedding(b64([1, 2, 3]))).toThrow();
  });
  it('rejects a zero vector and non-finite values', () => {
    expect(() => decodeEmbedding(b64(new Array(512).fill(0)))).toThrow();
    expect(() => decodeEmbedding(b64(new Array(512).fill(NaN)))).toThrow();
  });
});

describe('gallery file', () => {
  it('lives under the index-state directory', () => {
    expect(GALLERY_PATH.endsWith(path.join('.index-state', 'known-gallery.json'))).toBe(true);
  });

  it('round-trips the excluded record and loads an old file without it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-'));
    const file = path.join(dir, 'g.json');
    await saveGallery(file, { model: 'm', people: [], excluded: [{ id: 'Q9', refs: 2 }] });
    expect((await loadGallery(file))?.excluded).toEqual([{ id: 'Q9', refs: 2 }]);
    const old = path.join(dir, 'old.json');
    await fs.writeFile(old, JSON.stringify({ model: 'm', people: [{ id: 'p', name: 'P', aliases: [], refs: [b64(Array.from({ length: 512 }, () => 1))] }] }));
    const g = await loadGallery(old);
    expect(g?.people).toHaveLength(1);
    expect(g?.excluded).toBeUndefined();
  });

  it('round-trips refs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-'));
    const file = path.join(dir, 'sub', 'g.json');
    const ref = decodeEmbedding(b64(Array.from({ length: 512 }, (_, i) => i + 1)));
    await saveGallery(file, { model: 'buffalo_l', people: [{ id: 'p1', name: 'P One', aliases: ['x'], refs: [ref] }] });
    const g = await loadGallery(file);
    expect(g?.model).toBe('buffalo_l');
    expect(g?.people[0]).toMatchObject({ id: 'p1', name: 'P One', aliases: ['x'] });
    expect(Array.from(g!.people[0].refs[0])).toEqual(Array.from(ref));
  });

  it('returns undefined for a missing file', async () => {
    expect(await loadGallery('/nonexistent/dir/g.json')).toBeUndefined();
  });
});
