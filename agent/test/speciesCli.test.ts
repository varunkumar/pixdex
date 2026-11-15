import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBackfillSpecies, runBuildSpeciesRegions } from '../src/speciesCli';

const regions = { default: 'IN', regions: { IN: { country: 'IN' }, 'IN-KA': { country: 'IN', stateProvince: 'Karnataka' } }, rules: [] };
const config = { CLOUDFLARE_API_BASE_URL: 'https://x.workers.dev', INGEST_TOKEN: 't', SPECIES_SIDECAR_URL: 'http://127.0.0.1:8800' } as any;

describe('runBackfillSpecies', () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  const deps = (over: Record<string, unknown> = {}) => ({
    config,
    cloudflareClient: { speciesSummary: vi.fn().mockResolvedValue([{ album: 'Kanha', total: 10, pending: 4 }, { album: 'Goa', total: 5, pending: 0 }, { album: null, total: 2, pending: 2 }]) },
    sidecar: { model: vi.fn().mockResolvedValue('bioclip-2') },
    regions,
    backfill: vi.fn().mockResolvedValue({ total: 3, scanned: 2, withSpecies: 1, missing: 1, skippedDrive: 0, notIndexed: 0, failed: 0 }),
    createDriveReader: vi.fn().mockResolvedValue(undefined),
    ...over,
  });

  it('needs the species sidecar', async () => {
    expect(await runBackfillSpecies([], deps({ sidecar: undefined }) as any)).toBe(1);
    expect(err.join('\n')).toContain('SPECIES_SIDECAR_URL');
  });

  it('rejects bad arguments', async () => {
    expect(await runBackfillSpecies(['--limit', 'x'], deps() as any)).toBe(1);
    expect(err.join('\n')).toContain('--limit');
  });

  it('--list shows pending and total per album from the index, without scanning', async () => {
    const d = deps();
    expect(await runBackfillSpecies(['--list'], d as any)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Kanha');
    expect(text).toMatch(/4 of 10/);
    expect(text).toMatch(/\(no album\)/);
    expect(text).toMatch(/6 photos? to scan/);
    expect(d.backfill).not.toHaveBeenCalled();
  });

  it('runs the backfill over the chosen albums and reports the counts', async () => {
    const d = deps();
    expect(await runBackfillSpecies(['--album', 'Kanha', '--limit', '5', '--dry-run'], d as any)).toBe(0);
    expect(d.backfill).toHaveBeenCalledWith(expect.objectContaining({ albums: ['Kanha'], limit: 5, dryRun: true, regions }));
    expect(out.join('\n')).toMatch(/Scanned: 2/);
  });

  it('exits non-zero when a photo failed', async () => {
    const d = deps({ backfill: vi.fn().mockResolvedValue({ total: 1, scanned: 0, withSpecies: 0, missing: 0, skippedDrive: 0, notIndexed: 0, failed: 1 }) });
    expect(await runBackfillSpecies([], d as any)).toBe(1);
  });

  it('says when Drive photos will be skipped for lack of a login', async () => {
    const d = deps();
    await runBackfillSpecies([], d as any);
    expect(out.join('\n')).toMatch(/Google Drive photos will be skipped/);
  });
});

describe('runBuildSpeciesRegions', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('builds every configured region by default, or only the named ones', async () => {
    const build = vi.fn().mockResolvedValue('/x/IN.json');
    expect(await runBuildSpeciesRegions([], { regions, build, dir: '/x' } as any)).toBe(0);
    expect(build.mock.calls.map((c) => c[0])).toEqual(['IN', 'IN-KA']);
    build.mockClear();
    expect(await runBuildSpeciesRegions(['IN-KA'], { regions, build, dir: '/x' } as any)).toBe(0);
    expect(build.mock.calls.map((c) => c[0])).toEqual(['IN-KA']);
  });

  it('rejects an unknown region and reports a GBIF failure', async () => {
    expect(await runBuildSpeciesRegions(['XX'], { regions, build: vi.fn(), dir: '/x' } as any)).toBe(1);
    expect(await runBuildSpeciesRegions([], { regions, build: vi.fn().mockRejectedValue(new Error('GBIF request failed: 503')), dir: '/x' } as any)).toBe(1);
  });
});
