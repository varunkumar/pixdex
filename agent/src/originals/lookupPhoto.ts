export interface IndexedPhotoLookup {
  source: string;
  path: string | null;
}

export async function fetchIndexedPhoto(
  baseUrl: string,
  id: string,
  fetchFn: typeof fetch = fetch
): Promise<IndexedPhotoLookup | null> {
  const response = await fetchFn(`${baseUrl}/photos/${id}`);

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to look up photo ${id}: ${response.status}`);
  }

  const body = (await response.json()) as { source?: string; path?: string | null };
  return { source: body.source ?? '', path: body.path ?? null };
}
