import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillSpecies } from '../src/backfillSpecies';
import type { PendingSpeciesPhoto } from '../src/cloudflareClient';
import type { RegionsConfig } from '../src/species/regions';

const regions: RegionsConfig = {
  default: 'IN',
  regions: { IN: { country: 'IN' }, 'IN-KA': { country: 'IN', stateProvince: 'Karnataka' } },
  rules: [{ region: 'IN-KA', albumPattern: 'bandipur' }],
};

const tiger = { model: 'bioclip-2', whole: [['Tiger', 'Panthera tigris', 'Mammalia', 0.97]], boxes: [] };
const nothing = { model: 'bioclip-2', whole: [['Dhole', 'Cuon alpinus', 'Mammalia', 0.2]], boxes: [] };

describe('backfillSpecies', () => {
  let dir: string;
  let fileA: string;
  let fileB: string;
  let fileC: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-bf-species-'));
    [fileA, fileB, fileC] = ['a', 'b', 'c'].map((n) => path.join(dir, `${n}.jpg`));
    await sharp({ create: { width: 3200, height: 1600, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(fileA);
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toFile(fileB);
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toFile(fileC);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const local = (hash: string, file: string, over: Partial<PendingSpeciesPhoto> = {}): PendingSpeciesPhoto => ({
    contentHash: hash, source: 'local', path: file, driveFileId: null, album: 'Bandipur (2025)', filename: `${hash}.jpg`, latitude: null, longitude: null, subjects: [], ...over,
  });
  const drive = (hash: string, id: string): PendingSpeciesPhoto => ({ ...local(hash, ''), source: 'google_drive', path: null, driveFileId: id });

  const setup = (pages: { items: PendingSpeciesPhoto[]; nextCursor: number | null }[], identify = vi.fn().mockResolvedValue(tiger)) => {
    const pending = vi.fn();
    pages.forEach((p) => pending.mockResolvedValueOnce(p));
    const cloudflareClient = {
      speciesPending: pending,
      ingestSpecies: vi.fn().mockImplementation(async (_m: string, photos: unknown[]) => ({ updated: photos.length, unknown: 0 })),
    };
    const sidecar = { model: vi.fn().mockResolvedValue('bioclip-2'), identify };
    return { cloudflareClient, sidecar };
  };
  const run = (deps: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
    backfillSpecies({ cloudflareClient: deps.cloudflareClient as any, sidecar: deps.sidecar as any, regions, ...extra });

  it('scans what the index says is pending and stores the chosen species with the model', async () => {
    const d = setup([{ items: [local('hA', fileB)], nextCursor: null }]);
    const result = await run(d);

    expect(result).toMatchObject({ total: 1, scanned: 1, withSpecies: 1, failed: 0, missing: 0 });
    expect(d.cloudflareClient.speciesPending).toHaveBeenCalledWith('bioclip-2', { cursor: undefined, album: undefined });
    expect(d.cloudflareClient.ingestSpecies).toHaveBeenCalledWith('bioclip-2', [
      { contentHash: 'hA', species: [{ common: 'Tiger', scientific: 'Panthera tigris', score: 0.97 }] },
    ]);
  });

  it('sends the sidecar a downsized upright jpeg and the region from the album', async () => {
    const identify = vi.fn().mockResolvedValue(tiger);
    const d = setup([{ items: [local('hA', fileA)], nextCursor: null }], identify);
    await run(d);
    const [jpeg, region] = identify.mock.calls[0];
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(region).toBe('IN-KA');
  });

  it('records a photo with nothing confident as scanned, with an empty list', async () => {
    const d = setup([{ items: [local('hA', fileB)], nextCursor: null }], vi.fn().mockResolvedValue(nothing));
    const result = await run(d);
    expect(result).toMatchObject({ scanned: 1, withSpecies: 0 });
    expect(d.cloudflareClient.ingestSpecies).toHaveBeenCalledWith('bioclip-2', [{ contentHash: 'hA', species: [] }]);
  });

  it('follows the cursor and keeps going until the Worker has nothing left', async () => {
    const d = setup([
      { items: [local('hA', fileB)], nextCursor: 7 },
      { items: [local('hB', fileC)], nextCursor: null },
    ]);
    const result = await run(d);
    expect(result.scanned).toBe(2);
    expect(d.cloudflareClient.speciesPending).toHaveBeenNthCalledWith(2, 'bioclip-2', { cursor: 7, album: undefined });
  });

  it('opens Google Drive photos through the Drive reader', async () => {
    const openDriveFile = vi.fn().mockResolvedValue(await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    const d = setup([{ items: [drive('gA', 'file-1')], nextCursor: null }]);
    const result = await run(d, { openDriveFile });
    expect(openDriveFile).toHaveBeenCalledWith('file-1');
    expect(result).toMatchObject({ scanned: 1, skippedDrive: 0 });
  });

  it('skips Drive photos when there is no Drive login, leaving them pending', async () => {
    const d = setup([{ items: [drive('gA', 'file-1'), local('hB', fileB)], nextCursor: null }]);
    const result = await run(d);
    expect(result).toMatchObject({ scanned: 1, skippedDrive: 1 });
    expect(d.cloudflareClient.ingestSpecies).toHaveBeenCalledWith('bioclip-2', [expect.objectContaining({ contentHash: 'hB' })]);
  });

  it('counts a Drive file that cannot be read as failed and goes on', async () => {
    const openDriveFile = vi.fn().mockRejectedValue(new Error('404'));
    const d = setup([{ items: [drive('gA', 'file-1'), local('hB', fileB)], nextCursor: null }]);
    const result = await run(d, { openDriveFile });
    expect(result).toMatchObject({ scanned: 1, failed: 1 });
  });

  it('counts a missing local file (drive unmounted) and does not store anything for it', async () => {
    const d = setup([{ items: [local('hA', path.join(dir, 'gone.jpg'))], nextCursor: null }]);
    const result = await run(d);
    expect(result).toMatchObject({ total: 1, missing: 1, scanned: 0 });
    expect(d.cloudflareClient.ingestSpecies).not.toHaveBeenCalled();
    expect(d.sidecar.identify).not.toHaveBeenCalled();
  });

  it('a failing photo is counted and left pending; the others are still stored', async () => {
    const identify = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(tiger);
    const d = setup([{ items: [local('hA', fileB), local('hB', fileC)], nextCursor: null }], identify);
    const result = await run(d);
    expect(result).toMatchObject({ scanned: 1, failed: 1 });
    expect(d.cloudflareClient.ingestSpecies).toHaveBeenCalledWith('bioclip-2', [expect.objectContaining({ contentHash: 'hB' })]);
  });

  it('stops after five failures in a row (the sidecar is down) but keeps what it already finished', async () => {
    const identify = vi.fn().mockResolvedValueOnce(tiger).mockRejectedValue(new Error('connection refused'));
    const files = [fileB, fileC, fileB, fileC, fileB, fileC, fileB];
    const d = setup([{ items: files.map((f, i) => local(`h${i}`, f)), nextCursor: null }], identify);
    await expect(run(d)).rejects.toThrow(/5 times in a row/);
    expect(d.cloudflareClient.ingestSpecies).toHaveBeenCalledWith('bioclip-2', [expect.objectContaining({ contentHash: 'h0' })]);
  });

  it('writes in batches and flushes the remainder', async () => {
    const d = setup([{ items: [local('h1', fileB), local('h2', fileC), local('h3', fileB)], nextCursor: null }]);
    await run(d, { batchSize: 2 });
    expect(d.cloudflareClient.ingestSpecies).toHaveBeenCalledTimes(2);
    expect((d.cloudflareClient.ingestSpecies.mock.calls[0][1] as unknown[]).length).toBe(2);
    expect((d.cloudflareClient.ingestSpecies.mock.calls[1][1] as unknown[]).length).toBe(1);
  });

  it('dry run identifies but writes nothing', async () => {
    const d = setup([{ items: [local('hA', fileB)], nextCursor: null }]);
    const messages: string[] = [];
    const result = await run(d, { dryRun: true, onProgress: (m: string) => messages.push(m) });
    expect(result).toMatchObject({ scanned: 1, withSpecies: 1 });
    expect(d.cloudflareClient.ingestSpecies).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain('Tiger');
  });

  it('stops after the limit', async () => {
    const d = setup([{ items: [local('h1', fileB), local('h2', fileC), local('h3', fileB)], nextCursor: null }]);
    const result = await run(d, { limit: 2 });
    expect(result.scanned).toBe(2);
  });

  it('scans one album at a time when albums are given', async () => {
    const d = setup([
      { items: [local('h1', fileB)], nextCursor: null },
      { items: [local('h2', fileC)], nextCursor: null },
    ]);
    const result = await run(d, { albums: ['Kanha', 'Bandipur'] });
    expect(result.scanned).toBe(2);
    expect(d.cloudflareClient.speciesPending).toHaveBeenNthCalledWith(1, 'bioclip-2', { cursor: undefined, album: 'Kanha' });
    expect(d.cloudflareClient.speciesPending).toHaveBeenNthCalledWith(2, 'bioclip-2', { cursor: undefined, album: 'Bandipur' });
  });

  it('counts hashes the Worker no longer knows', async () => {
    const d = setup([{ items: [local('hA', fileB)], nextCursor: null }]);
    d.cloudflareClient.ingestSpecies.mockResolvedValue({ updated: 0, unknown: 1 });
    const result = await run(d);
    expect(result.notIndexed).toBe(1);
  });
});
