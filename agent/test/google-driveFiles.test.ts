import { describe, expect, it, vi } from 'vitest';
import { listDriveFolders, listImagesInDriveFolder, type DriveFilesClient } from '../src/google/driveFiles';

describe('listDriveFolders', () => {
  it('searches by name and returns id/name pairs, escaping quotes in the query', async () => {
    const list = vi.fn().mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Kanha 2026' }] } });
    const client: DriveFilesClient = { list, get: vi.fn() };

    const folders = await listDriveFolders(client, `O'Brien's Trip`);

    expect(folders).toEqual([{ id: 'f1', name: 'Kanha 2026' }]);
    const [params] = list.mock.calls[0];
    expect(params.q).toContain("mimeType='application/vnd.google-apps.folder'");
    expect(params.q).toContain("name contains 'O\\'Brien\\'s Trip'");
  });
});

describe('listImagesInDriveFolder', () => {
  it('paginates through all pages and filters to image mimeTypes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg' }],
          nextPageToken: 'page2',
        },
      })
      .mockResolvedValueOnce({
        data: { files: [{ id: 'i2', name: 'b.png', mimeType: 'image/png' }] },
      });
    const client: DriveFilesClient = { list, get: vi.fn() };

    const images = await listImagesInDriveFolder(client, 'folder-1');

    expect(images).toEqual([
      { id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg' },
      { id: 'i2', name: 'b.png', mimeType: 'image/png' },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0].pageToken).toBe('page2');
    expect(list.mock.calls[0][0].q).toContain("'folder-1' in parents");
    expect(list.mock.calls[0][0].q).toContain("mimeType contains 'image/'");
  });
});
