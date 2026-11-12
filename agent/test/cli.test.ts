import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigMock = vi.fn();
const indexLocalFolderMock = vi.fn();
const runIndexDriveMock = vi.fn();
const runServeOriginalsMock = vi.fn();
const backfillFacesMock = vi.fn();
const backfillKnownMock = vi.fn();
const buildGalleryMock = vi.fn();
const loadGalleryMock = vi.fn();
const saveGalleryMock = vi.fn();
const restoreMock = vi.fn();
const pushMock = vi.fn();
const pullMock = vi.fn();

vi.mock('../src/config', () => ({ loadConfig: loadConfigMock }));
vi.mock('../src/indexLocalFolder', () => ({ indexLocalFolder: indexLocalFolderMock }));
vi.mock('../src/cloudflareClient', () => ({ CloudflareClient: vi.fn() }));
vi.mock('../src/ollama/client', () => ({ OllamaClient: vi.fn() }));
vi.mock('../src/driveCli', () => ({ runIndexDrive: runIndexDriveMock }));
vi.mock('../src/backfillFaces', () => ({ backfillFaces: backfillFacesMock }));
vi.mock('../src/backfillKnown', () => ({ backfillKnown: backfillKnownMock }));
vi.mock('../src/faces/sidecarClient', () => ({
  FaceSidecarClient: vi.fn(),
  createFaceSidecar: (config: { FACE_SIDECAR_URL?: string }) => (config.FACE_SIDECAR_URL ? {} : undefined),
}));
vi.mock('../src/known/buildGallery', () => ({ buildGallery: buildGalleryMock }));
vi.mock('../src/known/wikimedia', () => ({ WikimediaClient: vi.fn() }));
vi.mock('../src/known/gallery', () => ({
  GALLERY_PATH: '/tmp/known-gallery.json',
  loadGallery: loadGalleryMock,
  saveGallery: saveGalleryMock,
}));
vi.mock('../src/known/galleryBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/known/galleryBackup')>()),
  restoreFromR2: restoreMock,
  pushGallery: pushMock,
  pullGallery: pullMock,
}));
vi.mock('../src/originalsCli', () => ({ runServeOriginals: runServeOriginalsMock }));

const { runCli } = await import('../src/cli');

describe('runCli', () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'qwen3.5:27b-mlx',
    });
    indexLocalFolderMock.mockReset().mockResolvedValue({ total: 1, indexed: 1, skipped: 0, failed: 0 });
  });

  it('runs indexLocalFolder for "index-local <folder>" and returns 0', async () => {
    const code = await runCli(['index-local', '/tmp/photos']);
    expect(code).toBe(0);
    expect(indexLocalFolderMock).toHaveBeenCalledWith('/tmp/photos', expect.any(Object));
  });

  it('returns 1 and does not run indexing when the folder argument is missing', async () => {
    const code = await runCli(['index-local']);
    expect(code).toBe(1);
    expect(indexLocalFolderMock).not.toHaveBeenCalled();
  });

  it('returns 1 for an unknown command', async () => {
    const code = await runCli(['bogus-command', '/tmp/photos']);
    expect(code).toBe(1);
    expect(indexLocalFolderMock).not.toHaveBeenCalled();
  });

  it('delegates "index-drive" to runIndexDrive', async () => {
    runIndexDriveMock.mockReset().mockResolvedValue(0);
    const code = await runCli(['index-drive']);
    expect(code).toBe(0);
    expect(runIndexDriveMock).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
  });

  it('catches errors from runIndexDrive, logs a clean error, and returns 1', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runIndexDriveMock.mockReset().mockRejectedValue(new Error('Token refresh failed'));

    const code = await runCli(['index-drive']);

    expect(code).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Token refresh failed');
    consoleErrorSpy.mockRestore();
  });

  it('delegates "serve-originals" to runServeOriginals', async () => {
    runServeOriginalsMock.mockReset().mockReturnValue(0);
    const code = await runCli(['serve-originals']);
    expect(code).toBe(0);
    expect(runServeOriginalsMock).toHaveBeenCalledWith(expect.any(Object));
  });

  it('backfill-faces exits 1 on a failure', async () => {
    loadConfigMock.mockReturnValue({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
      FACE_SIDECAR_URL: 'http://127.0.0.1:8799',
    });
    backfillFacesMock.mockReset().mockResolvedValue({ total: 2, scanned: 1, faces: 3, missing: 0, notIndexed: 0, failed: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCli(['backfill-faces', '/tmp/photos'])).toBe(1);
    backfillFacesMock.mockResolvedValue({ total: 2, scanned: 2, faces: 3, missing: 0, notIndexed: 0, failed: 0 });
    expect(await runCli(['backfill-faces', '/tmp/photos'])).toBe(0);
  });

  it('backfill-faces runs from the index with no folder, and scopes by path prefix when given one', async () => {
    loadConfigMock.mockReturnValue({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
      FACE_SIDECAR_URL: 'http://127.0.0.1:8799',
    });
    backfillFacesMock.mockReset().mockResolvedValue({ total: 0, scanned: 0, faces: 0, missing: 0, notIndexed: 0, failed: 0 });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCli(['backfill-faces'])).toBe(0);
    expect(backfillFacesMock.mock.calls[0][0].pathPrefix).toBeUndefined();

    expect(await runCli(['backfill-faces', '/tmp/photos'])).toBe(0);
    expect(backfillFacesMock.mock.calls[1][0].pathPrefix).toBe('/tmp/photos/');

    expect(await runCli(['backfill-faces', '--recrop'])).toBe(0);
    expect(backfillFacesMock.mock.calls[2][0]).toMatchObject({ missingCrops: true, pathPrefix: undefined });
  });

  it('backfill-faces exits 1 when FACE_SIDECAR_URL is not set', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    backfillFacesMock.mockReset();
    expect(await runCli(['backfill-faces', '/tmp/photos'])).toBe(1);
    expect(backfillFacesMock).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  describe('build-known-gallery', () => {
    const upsertMock = vi.fn();
    const statusMock = vi.fn();
    const gallery = { model: 'm1', people: [{ id: 'Q1', name: 'A', aliases: ['x'], refs: [new Float32Array(512)] }] };

    beforeEach(async () => {
      const { CloudflareClient } = await import('../src/cloudflareClient');
      vi.mocked(CloudflareClient).mockImplementation(function () {
        return { upsertKnownPeople: upsertMock, knownGalleryStatus: statusMock };
      } as never);
      upsertMock.mockReset().mockResolvedValue(1);
      statusMock.mockReset().mockResolvedValue({ exists: true, size: 100 });
      loadGalleryMock.mockReset().mockResolvedValue(undefined);
      saveGalleryMock.mockReset().mockResolvedValue(undefined);
      restoreMock.mockReset().mockResolvedValue(undefined);
      pushMock.mockReset().mockResolvedValue(11 * 1024 * 1024);
      buildGalleryMock.mockReset().mockResolvedValue({
        gallery,
        report: {
          included: [{ id: 'Q1', name: 'A', refs: 4 }],
          excluded: [{ id: 'Q2', name: 'B', refs: 1 }],
          failed: [{ id: 'Q3', name: 'C', error: 'HTTP 429' }],
          averageRefs: 4,
        },
      });
      loadConfigMock.mockReturnValue({
        CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
        INGEST_TOKEN: 'secret-token',
        FACE_SIDECAR_URL: 'http://127.0.0.1:8799',
      });
    });

    it('saves the gallery, upserts only included people and prints the report', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(saveGalleryMock).toHaveBeenCalledWith('/tmp/known-gallery.json', gallery);
      expect(upsertMock).toHaveBeenCalledWith([{ id: 'Q1', name: 'A', aliases: ['x'] }]);
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('4');
      expect(out).toContain('Q2');
      expect(out).toContain('Q3');
      log.mockRestore();
    });

    it('passes a checkpoint that saves the gallery, and upserts in batches of 500', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const big = {
        model: 'm1',
        people: Array.from({ length: 1200 }, (_, i) => ({ id: `Q${i}`, name: `N${i}`, aliases: [], refs: [] })),
      };
      buildGalleryMock.mockResolvedValue({
        gallery: big,
        report: { included: [], excluded: [], failed: [], averageRefs: 0 },
      });
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(upsertMock.mock.calls.map((c) => c[0].length)).toEqual([500, 500, 200]);
      await buildGalleryMock.mock.calls[0][0].onCheckpoint(big);
      expect(saveGalleryMock).toHaveBeenCalledWith('/tmp/known-gallery.json', big);
      log.mockRestore();
    });

    it('passes existing gallery and --rebuild ids; --full ignores the existing gallery', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      loadGalleryMock.mockResolvedValue(gallery);
      await runCli(['build-known-gallery', '--rebuild', 'Q1', 'Q9']);
      expect(buildGalleryMock.mock.calls[0][0]).toMatchObject({ existing: gallery, rebuild: ['Q1', 'Q9'] });
      expect(buildGalleryMock.mock.calls[0][0].retryExcluded).toBe(false);
      await runCli(['build-known-gallery', '--retry-excluded']);
      expect(buildGalleryMock.mock.calls[1][0].retryExcluded).toBe(true);
      buildGalleryMock.mockClear();
      await runCli(['build-known-gallery', '--full']);
      expect(buildGalleryMock.mock.calls[0][0].existing).toBeUndefined();
      log.mockRestore();
    });

    it('restores from R2 when the local file is missing and builds incrementally from it', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      restoreMock.mockResolvedValue(gallery);
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(restoreMock).toHaveBeenCalledTimes(1);
      expect(restoreMock.mock.calls[0][1]).toBe('/tmp/known-gallery.json');
      expect(buildGalleryMock.mock.calls[0][0].existing).toBe(gallery);
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('Restored the known gallery from R2: 1 people, model m1');
      log.mockRestore();
    });

    it('local wins when it loads: no R2 download', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      loadGalleryMock.mockResolvedValue(gallery);
      await runCli(['build-known-gallery']);
      expect(restoreMock).not.toHaveBeenCalled();
      expect(buildGalleryMock.mock.calls[0][0].existing).toBe(gallery);
      log.mockRestore();
    });

    it('an unreadable local file warns and falls back to R2', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadGalleryMock.mockRejectedValue(new Error('bad json'));
      restoreMock.mockResolvedValue(gallery);
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(String(warn.mock.calls[0][0])).toContain('bad json');
      expect(buildGalleryMock.mock.calls[0][0].existing).toBe(gallery);
      log.mockRestore();
      warn.mockRestore();
    });

    it('builds from scratch when neither local nor R2 has a gallery (a corrupt R2 object restores as undefined)', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(buildGalleryMock.mock.calls[0][0].existing).toBeUndefined();
      log.mockRestore();
    });

    it('--full skips both the local file and the R2 restore, and still pushes', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      loadGalleryMock.mockResolvedValue(gallery);
      expect(await runCli(['build-known-gallery', '--full'])).toBe(0);
      expect(restoreMock).not.toHaveBeenCalled();
      expect(loadGalleryMock).not.toHaveBeenCalled();
      expect(pushMock).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    it('pushes the saved file after a changed build, once, at the end', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock.mock.calls[0][1]).toBe('/tmp/known-gallery.json');
      expect(saveGalleryMock.mock.invocationCallOrder[0]).toBeLessThan(pushMock.mock.invocationCallOrder[0]);
      log.mockRestore();
    });

    it('skips the push when nothing changed', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      loadGalleryMock.mockResolvedValue(gallery);
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(pushMock).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('an unchanged build still pushes when R2 has no backup (existing local gallery, first run)', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      loadGalleryMock.mockResolvedValue(gallery);
      statusMock.mockResolvedValue({ exists: false, size: null });
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(pushMock).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    it('an unchanged build with an existing backup does not push and says it is up to date', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      loadGalleryMock.mockResolvedValue(gallery);
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(pushMock).not.toHaveBeenCalled();
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('R2 backup is up to date');
      log.mockRestore();
    });

    it('a failing status call only warns; it pushes only if the gallery changed', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      statusMock.mockRejectedValue(new Error('status failed: 500'));
      loadGalleryMock.mockResolvedValue(gallery);
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(pushMock).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('status failed: 500');
      loadGalleryMock.mockResolvedValue(undefined);
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(pushMock).toHaveBeenCalledTimes(1);
      log.mockRestore();
      warn.mockRestore();
    });

    it('a restored gallery of another model is handed to the build, which ignores it; the rebuilt gallery replaces the file', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stale = { model: 'old-model', people: gallery.people };
      restoreMock.mockResolvedValue(stale);
      expect(await runCli(['build-known-gallery'])).toBe(0);
      expect(buildGalleryMock.mock.calls[0][0].existing).toBe(stale);
      // the build returns a gallery of the current model: it is saved over the restored file and pushed (changed)
      expect(saveGalleryMock).toHaveBeenLastCalledWith('/tmp/known-gallery.json', gallery);
      expect(pushMock).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    it('a failed push warns and still exits 0', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pushMock.mockRejectedValue(new Error('ingest/known-gallery put failed: 500'));
      expect(await runCli(['build-known-gallery'])).toBe(0);
      const out = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('could not back up');
      expect(out).toContain('500');
      expect(out).toContain('local file is saved');
      log.mockRestore();
      warn.mockRestore();
    });

    it('exits 1 when the R2 check itself fails (no blind multi-hour crawl)', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      restoreMock.mockRejectedValue(new Error('ingest/known-gallery get failed: 500'));
      expect(await runCli(['build-known-gallery'])).toBe(1);
      expect(buildGalleryMock).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('exits 1 when FACE_SIDECAR_URL is not set', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      loadConfigMock.mockReturnValue({ CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev', INGEST_TOKEN: 't' });
      expect(await runCli(['build-known-gallery'])).toBe(1);
      expect(err).toHaveBeenCalledWith('Error: FACE_SIDECAR_URL is not set (start the sidecar, see agent/sidecar/README.md)');
      expect(buildGalleryMock).not.toHaveBeenCalled();
      err.mockRestore();
    });
  });

  describe('backfill-known', () => {
    const gallery = { model: 'm1', people: [] };
    const result = {
      scanned: 5,
      skipped: 0,
      matched: 2,
      cleared: 0,
      written: 0,
      perPerson: [{ id: 'Q1', name: 'Alice', count: 2 }],
      scoreBuckets: { '0.55': 2 },
      samples: [{ faceId: 'face-1', knownId: 'Q1', score: 0.57 }],
    };

    beforeEach(() => {
      backfillKnownMock.mockReset().mockResolvedValue(result);
      loadGalleryMock.mockReset().mockResolvedValue(gallery);
      restoreMock.mockReset().mockResolvedValue(undefined);
    });

    it('restores the gallery from R2 when the local file is missing', async () => {
      loadGalleryMock.mockResolvedValue(undefined);
      restoreMock.mockResolvedValue(gallery);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await runCli(['backfill-known'])).toBe(0);
      expect(restoreMock).toHaveBeenCalledTimes(1);
      expect(backfillKnownMock).toHaveBeenCalledWith(expect.objectContaining({ gallery, model: 'm1' }));
      log.mockRestore();
    });

    it('does not touch R2 when the local file exists', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runCli(['backfill-known']);
      expect(restoreMock).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('refuses when the gallery is missing, pointing at build-known-gallery', async () => {
      loadGalleryMock.mockResolvedValue(undefined);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await runCli(['backfill-known'])).toBe(1);
      expect(String(err.mock.calls[0][0])).toContain('build-known-gallery');
      expect(backfillKnownMock).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('passes flags and gallery.model, needs no sidecar, and prints the dry run report', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await runCli(['backfill-known', '--dry-run', '--rescore'])).toBe(0);
      expect(backfillKnownMock).toHaveBeenCalledWith(
        expect.objectContaining({ gallery, model: 'm1', dryRun: true, rescore: true })
      );
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('Alice');
      expect(out).toContain('face-1');
      expect(out).toContain('0.55');
      expect(out).toContain('Dry run: nothing was written.');
      log.mockRestore();
    });

    it('passes --page-size and rejects values outside 1 to 100', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await runCli(['backfill-known', '--page-size', '25'])).toBe(0);
      expect(backfillKnownMock).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 25 }));
      backfillKnownMock.mockClear();
      for (const bad of ['0', '101', 'abc', '2.5']) expect(await runCli(['backfill-known', '--page-size', bad])).toBe(1);
      expect(await runCli(['backfill-known', '--page-size'])).toBe(1);
      expect(backfillKnownMock).not.toHaveBeenCalled();
      log.mockRestore();
      err.mockRestore();
    });

    it('exits 1 with the error message when the backfill throws', async () => {
      backfillKnownMock.mockRejectedValue(new Error('boom'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await runCli(['backfill-known'])).toBe(1);
      expect(err).toHaveBeenCalledWith('Error: boom');
      err.mockRestore();
    });
  });

  describe('known-gallery-push and known-gallery-pull', () => {
    const gallery = { model: 'm1', people: [{ id: 'Q1' }, { id: 'Q2' }] };
    beforeEach(() => {
      pushMock.mockReset().mockResolvedValue(2 * 1024 * 1024);
      pullMock.mockReset();
    });

    it('push uploads the local file and exits 0; a failure exits 1', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await runCli(['known-gallery-push'])).toBe(0);
      expect(pushMock.mock.calls[0][1]).toBe('/tmp/known-gallery.json');
      pushMock.mockRejectedValue(new Error('no gallery file at /tmp/known-gallery.json'));
      expect(await runCli(['known-gallery-push'])).toBe(1);
      log.mockRestore();
      err.mockRestore();
    });

    it('pull refuses to overwrite an existing file without --force', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      pullMock.mockResolvedValue({ status: 'exists' });
      expect(await runCli(['known-gallery-pull'])).toBe(1);
      expect(pullMock.mock.calls[0][2]).toMatchObject({ force: false });
      expect(String(err.mock.calls[0][0])).toContain('--force');
      err.mockRestore();
    });

    it('pull --force passes force and reports the restored gallery', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      pullMock.mockResolvedValue({ status: 'pulled', gallery });
      expect(await runCli(['known-gallery-pull', '--force'])).toBe(0);
      expect(pullMock.mock.calls[0][2]).toMatchObject({ force: true });
      expect(String(log.mock.calls[0][0])).toContain('2 people, model m1');
      log.mockRestore();
    });

    it('pull exits 1 when R2 has no usable gallery', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      pullMock.mockResolvedValue({ status: 'absent' });
      expect(await runCli(['known-gallery-pull'])).toBe(1);
      err.mockRestore();
    });
  });

  describe('known list commands', () => {
    const entity = (id: string, over: { human?: boolean; portrait?: boolean; label?: string } = {}) => ({
      id,
      labels: { en: { value: over.label ?? 'New Person' } },
      descriptions: { en: { value: 'd' } },
      claims: {
        P31: [{ mainsnak: { datavalue: { value: { id: over.human === false ? 'Q43229' : 'Q5' } } } }],
        ...(over.portrait === false ? {} : { P18: [{ mainsnak: { datavalue: { value: 'X.jpg' } } }] }),
      },
      sitelinks: { enwiki: {} },
    });

    async function setup(initial: unknown[]) {
      const fsp = await import('node:fs/promises');
      const os = await import('node:os');
      const dir = await fsp.mkdtemp(`${os.tmpdir()}/known-cli-`);
      const file = `${dir}/people.json`;
      await fsp.writeFile(file, JSON.stringify(initial));
      process.env.KNOWN_PEOPLE_PATH = file;
      return file;
    }
    const read = async (file: string) => (await import('node:fs/promises')).readFile(file, 'utf8');

    function stubFetch(entities: Record<string, unknown>) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const url = new URL(String(input));
          if (url.searchParams.get('action') === 'wbsearchentities') {
            return new Response(JSON.stringify({ search: Object.keys(entities).map((id) => ({ id })) }));
          }
          const out: Record<string, unknown> = {};
          for (const id of (url.searchParams.get('ids') ?? '').split('|')) out[id] = entities[id] ?? { id, missing: '' };
          return new Response(JSON.stringify({ entities: out }));
        })
      );
    }

    it('known-add refuses a duplicate id and a non-human, appends a valid one sorted and stable', async () => {
      const file = await setup([{ id: 'Q1', name: 'Zed', aliases: [] }]);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      stubFetch({ Q1: entity('Q1', { label: 'Zed' }), Q2: entity('Q2', { human: false }), Q3: entity('Q3') });

      expect(await runCli(['known-add', '--id', 'Q1'])).toBe(1);
      expect(await runCli(['known-add', '--id', 'Q2'])).toBe(1);
      expect(JSON.parse(await read(file))).toHaveLength(1);

      expect(await runCli(['known-add', '--id', 'Q3', '--alias', 'NP', '--alias', 'Newbie'])).toBe(0);
      const first = await read(file);
      expect(JSON.parse(first)).toEqual([
        { id: 'Q3', name: 'New Person', aliases: ['NP', 'Newbie'] },
        { id: 'Q1', name: 'Zed', aliases: [] },
      ]);
      expect(await runCli(['known-add', '--id', 'Q3', '--alias', 'NP', '--alias', 'Newbie'])).toBe(1);
      expect(await read(file)).toBe(first);
      err.mockRestore();
      log.mockRestore();
    });

    it('known-add refuses an id with neither portrait nor category and honors --name', async () => {
      const file = await setup([]);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      stubFetch({ Q5: entity('Q5', { portrait: false }), Q6: entity('Q6', { label: 'Other Label' }) });
      expect(await runCli(['known-add', '--id', 'Q5'])).toBe(1);
      expect(await runCli(['known-add', '--id', 'Q6', '--name', 'Other Label'])).toBe(0);
      expect(JSON.parse(await read(file))[0].name).toBe('Other Label');
      err.mockRestore();
      log.mockRestore();
    });

    it('known-check exits 1 with issues and 0 without; --offline makes no network calls', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await setup([{ id: 'Q1', name: 'Zed', aliases: [] }]);
      stubFetch({ Q1: entity('Q1', { label: 'Zed' }) });
      expect(await runCli(['known-check'])).toBe(0);
      await setup([
        { id: 'Q1', name: 'Zed', aliases: [] },
        { id: 'Q1', name: 'Amy', aliases: [] },
      ]);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      expect(await runCli(['known-check', '--offline'])).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('known-search prints candidates and needs a query', async () => {
      await setup([]);
      stubFetch({ Q9: entity('Q9', { label: 'Found One' }) });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await runCli(['known-search', 'found'])).toBe(0);
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Q9');
      expect(await runCli(['known-search'])).toBe(1);
      log.mockRestore();
      err.mockRestore();
    });
  });
});
