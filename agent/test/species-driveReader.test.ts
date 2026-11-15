import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createDriveReader } from '../src/species/driveReader';

const config = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's', DRIVE_STAGING_MAX_MB: 1 } as any;

const filesClient = (bytes: Buffer, headers: Record<string, string> = {}) => ({
  get: vi.fn().mockResolvedValue({ data: Readable.from([bytes]), headers }),
});

describe('createDriveReader', () => {
  it('reads a Drive file into memory using the stored login', async () => {
    const files = filesClient(Buffer.from([1, 2, 3]));
    const getAuthorizedClient = vi.fn().mockResolvedValue({});
    const read = await createDriveReader(config, { getAuthorizedClient, buildDriveClient: () => files as any });

    await expect(read!('file-1')).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(files.get).toHaveBeenCalledWith({ fileId: 'file-1', alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  });

  it('never starts a sign-in: with no stored login the reader is unavailable', async () => {
    let opened = 0;
    const getAuthorizedClient = vi.fn().mockImplementation(async (_c: unknown, deps: any) => {
      deps.openBrowser('https://accounts.example/consent');
      return deps.waitForAuthorizationCode('http://localhost/cb');
    });
    const read = await createDriveReader(config, { getAuthorizedClient, buildDriveClient: () => ({}) as any, onNoLogin: () => opened++ });
    expect(read).toBeUndefined();
    expect(opened).toBe(1);
  });

  it('is unavailable when the Google credentials are not configured', async () => {
    const getAuthorizedClient = vi.fn().mockRejectedValue(new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set'));
    expect(await createDriveReader({} as any, { getAuthorizedClient })).toBeUndefined();
  });

  it('refuses a file over the size limit, from the advertised length', async () => {
    const files = filesClient(Buffer.from([1]), { 'content-length': String(5 * 1024 * 1024) });
    const read = await createDriveReader(config, { getAuthorizedClient: (async () => ({})) as any, buildDriveClient: () => files as any });
    await expect(read!('big')).rejects.toThrow(/larger than/);
  });

  it('refuses a file that turns out over the limit while streaming', async () => {
    const files = filesClient(Buffer.alloc(2 * 1024 * 1024));
    const read = await createDriveReader(config, { getAuthorizedClient: (async () => ({})) as any, buildDriveClient: () => files as any });
    await expect(read!('big')).rejects.toThrow(/larger than/);
  });
});
