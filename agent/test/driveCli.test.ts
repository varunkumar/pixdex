import { describe, expect, it, vi } from 'vitest';
import { runIndexDrive } from '../src/driveCli';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  ORIGINALS_PORT: 8787,
};

describe('runIndexDrive', () => {
  it('prompts for a search term, lists matching folders, prompts for a choice, and indexes it', async () => {
    const prompts = ['Kanha', '1'];
    const prompt = vi.fn().mockImplementation(async () => prompts.shift());

    const listDriveFolders = vi.fn().mockResolvedValue([{ id: 'folder-1', name: 'Kanha 2026' }]);
    const indexGoogleDriveFolder = vi
      .fn()
      .mockResolvedValue({ total: 2, indexed: 1, skipped: 1, failed: 0 });
    const getAuthorizedClient = vi.fn().mockResolvedValue({ mock: 'auth-client' });
    const buildDriveClient = vi.fn().mockReturnValue({ mock: 'drive-client' });

    const code = await runIndexDrive(config, {
      prompt,
      getAuthorizedClient,
      buildDriveClient,
      listDriveFolders,
      indexGoogleDriveFolder,
    });

    expect(code).toBe(0);
    expect(listDriveFolders).toHaveBeenCalledWith({ mock: 'drive-client' }, 'Kanha');
    expect(indexGoogleDriveFolder).toHaveBeenCalledWith(
      { mock: 'drive-client' },
      'folder-1',
      'Kanha 2026',
      expect.any(Object)
    );
  });

  it('returns 1 and does not index when no folders match the search', async () => {
    const prompt = vi.fn().mockResolvedValue('Nonexistent');
    const listDriveFolders = vi.fn().mockResolvedValue([]);
    const indexGoogleDriveFolder = vi.fn();

    const code = await runIndexDrive(config, {
      prompt,
      getAuthorizedClient: vi.fn().mockResolvedValue({}),
      buildDriveClient: vi.fn().mockReturnValue({}),
      listDriveFolders,
      indexGoogleDriveFolder,
    });

    expect(code).toBe(1);
    expect(indexGoogleDriveFolder).not.toHaveBeenCalled();
  });

  it('indexes the folders named by --folder without prompting', async () => {
    const prompt = vi.fn();
    const getDriveFolder = vi.fn().mockResolvedValue({ id: '1AbC_dEf-GhIjKl', name: 'Kanha' });
    const listDriveFolders = vi.fn();
    const indexGoogleDriveFolder = vi.fn().mockResolvedValue({ total: 1, indexed: 1, skipped: 0, failed: 0 });

    const code = await runIndexDrive(config, {
      prompt,
      args: ['--folder', 'https://drive.google.com/drive/folders/1AbC_dEf-GhIjKl?usp=sharing'],
      getAuthorizedClient: vi.fn().mockResolvedValue({}),
      buildDriveClient: vi.fn().mockReturnValue({ mock: 'drive-client' }),
      getDriveFolder,
      listDriveFolders,
      indexGoogleDriveFolder,
    });

    expect(code).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(listDriveFolders).not.toHaveBeenCalled();
    expect(getDriveFolder).toHaveBeenCalledWith({ mock: 'drive-client' }, '1AbC_dEf-GhIjKl');
    expect(indexGoogleDriveFolder).toHaveBeenCalledWith(
      { mock: 'drive-client' },
      '1AbC_dEf-GhIjKl',
      'Kanha',
      expect.any(Object)
    );
  });

  it('returns 1 for a malformed --folder without touching Drive', async () => {
    const getAuthorizedClient = vi.fn();
    const code = await runIndexDrive(config, { prompt: vi.fn(), args: ['--folder', 'nope'], getAuthorizedClient });
    expect(code).toBe(1);
    expect(getAuthorizedClient).not.toHaveBeenCalled();
  });

  it('exits non-zero in --folder mode when any photo failed', async () => {
    const code = await runIndexDrive(config, {
      prompt: vi.fn(),
      args: ['--folder', '1AbC_dEf-GhIjKl'],
      getAuthorizedClient: vi.fn().mockResolvedValue({}),
      buildDriveClient: vi.fn().mockReturnValue({}),
      getDriveFolder: vi.fn().mockResolvedValue({ id: '1AbC_dEf-GhIjKl', name: 'K' }),
      indexGoogleDriveFolder: vi.fn().mockResolvedValue({ total: 2, indexed: 1, skipped: 0, failed: 1 }),
    });
    expect(code).toBe(1);
  });

  it('clears the stored token and returns 1 when Google rejects it (invalid_grant)', async () => {
    const clearStoredToken = vi.fn().mockResolvedValue(undefined);
    const code = await runIndexDrive(config, {
      prompt: vi.fn().mockResolvedValue('Kanha'),
      getAuthorizedClient: vi.fn().mockResolvedValue({}),
      buildDriveClient: vi.fn().mockReturnValue({}),
      listDriveFolders: vi.fn().mockRejectedValue({ response: { data: { error: 'invalid_grant' } } }),
      clearStoredToken,
    });
    expect(code).toBe(1);
    expect(clearStoredToken).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors without clearing the token', async () => {
    const clearStoredToken = vi.fn();
    await expect(
      runIndexDrive(config, {
        prompt: vi.fn().mockResolvedValue('Kanha'),
        getAuthorizedClient: vi.fn().mockResolvedValue({}),
        buildDriveClient: vi.fn().mockReturnValue({}),
        listDriveFolders: vi.fn().mockRejectedValue(new Error('network down')),
        clearStoredToken,
      })
    ).rejects.toThrow('network down');
    expect(clearStoredToken).not.toHaveBeenCalled();
  });
});
