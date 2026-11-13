import { describe, expect, it, vi } from 'vitest';
import { dryRunDriveFolder, formatDryRun } from '../src/google/dryRunDriveFolder';
import type { DriveFilesClient } from '../src/google/driveFiles';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'm',
  ORIGINALS_PORT: 8787,
  DRIVE_STAGING_MAX_MB: 100,
};

const FOLDER = 'application/vnd.google-apps.folder';
const MB = 1024 * 1024;

function tree(byParent: Record<string, unknown[]>): DriveFilesClient {
  return {
    list: vi.fn().mockImplementation(async ({ q }: { q: string }) => ({
      data: { files: byParent[/'([^']+)' in parents/.exec(q)![1]] ?? [] },
    })),
    get: vi.fn(),
  } as unknown as DriveFilesClient;
}

// Varun/
//   Adhiyan Photoshoot/   has Processed: only it is used
//     Processed/          big (over limit), old (already indexed)
//     Raw/                ignored
//     loose.jpg           ignored
//   05-July-2014/         plain: a, its duplicate, one without checksum, one RAW
const client = () =>
  tree({
    root: [
      { id: 'shoot', name: 'Adhiyan Photoshoot', mimeType: FOLDER },
      { id: 'july', name: '05-July-2014', mimeType: FOLDER },
    ],
    shoot: [
      { id: 'proc', name: 'Processed', mimeType: FOLDER },
      { id: 'raw', name: 'Raw', mimeType: FOLDER },
      { id: 'loose', name: 'loose.jpg', mimeType: 'image/jpeg', sha256Checksum: 'ee', size: String(MB) },
    ],
    proc: [
      { id: 'big', name: 'big.jpg', mimeType: 'image/jpeg', sha256Checksum: 'cc', size: String(300 * MB) },
      { id: 'old', name: 'old.jpg', mimeType: 'image/jpeg', sha256Checksum: 'dd', size: String(MB) },
    ],
    july: [
      { id: 'a', name: 'a.jpg', mimeType: 'image/jpeg', sha256Checksum: 'bb', size: String(3 * MB) },
      { id: 'dup', name: 'a copy.jpg', mimeType: 'image/jpeg', sha256Checksum: 'bb', size: String(3 * MB) },
      { id: 'nochk', name: 'n.jpg', mimeType: 'image/jpeg', size: String(MB) },
      { id: 'cr2', name: 'a.CR2', mimeType: 'image/x-canon-cr2', size: String(30 * MB) },
    ],
  });

describe('dryRunDriveFolder', () => {
  it('applies the Processed and RAW rules and classifies photos without downloading or writing', async () => {
    const drive = client();
    const checkHashes = vi.fn().mockResolvedValue(new Set(['dd']));

    const result = await dryRunDriveFolder(drive, 'root', 'Varun', { cloudflareClient: { checkHashes }, config });

    expect(drive.get).not.toHaveBeenCalled();
    expect(checkHashes).toHaveBeenCalledTimes(1);
    expect(checkHashes.mock.calls[0][0].sort()).toEqual(['bb', 'cc', 'dd']); // loose.jpg (ee) is never considered
    expect(result).toMatchObject({
      images: 5,
      alreadyIndexed: 2, // 'dd' known, plus the in-run copy of 'bb'
      overLimit: 1,
      unknown: 1,
      toIndex: 2, // a, nochk
      rawIgnored: 1,
      ignoredPhotos: 1,
      hashCheck: true,
    });
  });

  it('prints a directory tree with what is ignored and why', async () => {
    const result = await dryRunDriveFolder(client(), 'root', 'Varun', {
      cloudflareClient: { checkHashes: vi.fn().mockResolvedValue(new Set(['dd'])) },
      config,
    });

    expect(formatDryRun(result)).toEqual([
      'Varun/',
      '├── 05-July-2014/  3 photos, 7.0 MB, 1 already indexed, 1 unchecked (no Drive checksum)  [1 RAW ignored]',
      '└── Adhiyan Photoshoot/  [only Processed is used, ignoring 1 photos and 1 other folders outside it]',
      '    ├── Processed/  2 photos, 301.0 MB, 1 already indexed, 1 over size limit',
      '    └── Raw/  [ignored: a Processed folder exists next to it]',
      'Total: 5 photos (308.0 MB) in 4 folder(s), 2 album(s), 2 already indexed, 2 would be indexed, 1 refused (over size limit); 1 of those could still turn out to be indexed (no checksum)',
      'Ignored: 1 RAW files, 1 photos outside Processed folders (in folders that have one)',
    ]);
  });

  it('skips app/project folders by default, honours --exclude, and counts one album per top-level folder', async () => {
    const drive = tree({
      root: [
        { id: 'marriage', name: 'Arun Marriage', mimeType: FOLDER },
        { id: 'previews', name: 'Shoot Previews.lrdata', mimeType: FOLDER },
        { id: 'video', name: 'video', mimeType: FOLDER },
      ],
      marriage: [
        { id: 'a', name: 'Engagement', mimeType: FOLDER },
        { id: 'b', name: 'Marriage Photos', mimeType: FOLDER },
      ],
      a: [{ id: 'a1', name: 'a1.jpg', mimeType: 'image/jpeg' }],
      b: [{ id: 'b1', name: 'b1.jpg', mimeType: 'image/jpeg' }],
      previews: [{ id: 'p1', name: 'p1.jpg', mimeType: 'image/jpeg' }],
      video: [{ id: 'v1', name: 'v1.jpg', mimeType: 'image/jpeg' }],
    });
    const deps = { cloudflareClient: { checkHashes: vi.fn().mockResolvedValue(new Set()) }, config };

    const defaults = await dryRunDriveFolder(drive, 'root', 'Varun', deps);
    expect(defaults.images).toBe(3); // a1, b1, v1; the .lrdata folder is skipped
    expect(defaults.albums).toBe(2); // 'Arun Marriage' (both subfolders) and 'video'
    expect(formatDryRun(defaults)).toContain('├── Shoot Previews.lrdata/  [excluded: on the skip list]');

    const custom = await dryRunDriveFolder(drive, 'root', 'Varun', { ...deps, exclude: ['VIDEO'] });
    expect(custom.images).toBe(2);
    expect(custom.albums).toBe(1);
  });

  it('still lists when the Worker check fails, and says the counts are unavailable', async () => {
    const warnings: string[] = [];
    const result = await dryRunDriveFolder(client(), 'root', 'Varun', {
      cloudflareClient: { checkHashes: vi.fn().mockRejectedValue(new Error('check-hashes failed: 401')) },
      config,
      onWarning: (m) => warnings.push(m),
    });

    expect(result.hashCheck).toBe(false);
    expect(result.alreadyIndexed).toBe(1); // only the in-run copy
    expect(warnings[0]).toContain('401');
    const text = formatDryRun(result);
    expect(text.at(-1)).toContain('unavailable');
    expect(text.join('\n')).not.toContain('already indexed,'); // no per-folder "already indexed" claims
  });
});
