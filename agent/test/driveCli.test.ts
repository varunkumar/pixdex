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
});
