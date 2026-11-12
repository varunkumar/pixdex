import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigMock = vi.fn();
const indexLocalFolderMock = vi.fn();
const runIndexDriveMock = vi.fn();
const runServeOriginalsMock = vi.fn();
const backfillFacesMock = vi.fn();
const buildGalleryMock = vi.fn();
const loadGalleryMock = vi.fn();
const saveGalleryMock = vi.fn();

vi.mock('../src/config', () => ({ loadConfig: loadConfigMock }));
vi.mock('../src/indexLocalFolder', () => ({ indexLocalFolder: indexLocalFolderMock }));
vi.mock('../src/cloudflareClient', () => ({ CloudflareClient: vi.fn() }));
vi.mock('../src/ollama/client', () => ({ OllamaClient: vi.fn() }));
vi.mock('../src/driveCli', () => ({ runIndexDrive: runIndexDriveMock }));
vi.mock('../src/backfillFaces', () => ({ backfillFaces: backfillFacesMock }));
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
    const gallery = { model: 'm1', people: [{ id: 'Q1', name: 'A', aliases: ['x'], refs: [new Float32Array(512)] }] };

    beforeEach(async () => {
      const { CloudflareClient } = await import('../src/cloudflareClient');
      vi.mocked(CloudflareClient).mockImplementation(function () {
        return { upsertKnownPeople: upsertMock };
      } as never);
      upsertMock.mockReset().mockResolvedValue(1);
      loadGalleryMock.mockReset().mockResolvedValue(undefined);
      saveGalleryMock.mockReset().mockResolvedValue(undefined);
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
      await runCli(['build-known-gallery', '--full']);
      expect(buildGalleryMock.mock.calls[1][0].existing).toBeUndefined();
      log.mockRestore();
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
});
