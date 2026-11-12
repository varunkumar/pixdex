import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadKnownGallery } from '../src/known/loadKnownGallery';

describe('loadKnownGallery', () => {
  it('returns undefined silently for a missing file', async () => {
    const warn = vi.fn();
    expect(await loadKnownGallery(warn, path.join(os.tmpdir(), 'nope-gallery.json'))).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once and returns undefined for a corrupt file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-'));
    const file = path.join(dir, 'g.json');
    await fs.writeFile(file, '{not json');
    const warn = vi.fn();
    expect(await loadKnownGallery(warn, file)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
