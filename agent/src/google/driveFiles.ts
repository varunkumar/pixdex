import type { Readable } from 'node:stream';

export interface DriveFilesClient {
  list(params: {
    q: string;
    fields: string;
    pageToken?: string;
    pageSize?: number;
  }): Promise<{
    data: {
      files: Array<{ id?: string | null; name?: string | null; mimeType?: string | null }>;
      nextPageToken?: string | null;
    };
  }>;
  get(
    params: { fileId: string; alt: 'media' },
    options: { responseType: 'stream' }
  ): Promise<{ data: Readable }>;
}

export interface DriveFolderRef {
  id: string;
  name: string;
}

export interface DriveImageRef {
  id: string;
  name: string;
  mimeType: string;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function listDriveFolders(client: DriveFilesClient, query: string): Promise<DriveFolderRef[]> {
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name contains '${escapeDriveQueryValue(
    query
  )}'`;
  const response = await client.list({ q, fields: 'files(id,name)', pageSize: 50 });
  return (response.data.files ?? [])
    .filter((f): f is { id: string; name: string; mimeType?: string | null } => Boolean(f.id && f.name))
    .map((f) => ({ id: f.id, name: f.name }));
}

export async function listImagesInDriveFolder(
  client: DriveFilesClient,
  folderId: string
): Promise<DriveImageRef[]> {
  const images: DriveImageRef[] = [];
  let pageToken: string | undefined;

  do {
    const response = await client.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      pageToken,
      pageSize: 100,
    });

    for (const file of response.data.files ?? []) {
      if (file.id && file.name && file.mimeType) {
        images.push({ id: file.id, name: file.name, mimeType: file.mimeType });
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return images;
}
