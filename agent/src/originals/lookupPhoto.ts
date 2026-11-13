export interface IndexedPhotoLookup {
  source: string;
  path: string | null;
  /** Set for Google Drive photos (the Worker returns it to the album owner, the agent's viewer). */
  driveFileId: string | null;
}

export async function fetchIndexedPhoto(
  baseUrl: string,
  id: string,
  readToken: string,
  fetchFn: typeof fetch = fetch,
  // The Worker requires X-Viewer-Email on every read; serve-originals passes OWNER_EMAIL.
  viewerEmail?: string
): Promise<IndexedPhotoLookup | null> {
  const headers: Record<string, string> = { Authorization: `Bearer ${readToken}` };
  if (viewerEmail) headers['X-Viewer-Email'] = viewerEmail;
  const response = await fetchFn(`${baseUrl}/photos/${id}`, { headers });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to look up photo ${id}: ${response.status}`);
  }

  const body = (await response.json()) as { source?: string; path?: string | null; driveFileId?: string | null };
  return { source: body.source ?? '', path: body.path ?? null, driveFileId: body.driveFileId ?? null };
}
