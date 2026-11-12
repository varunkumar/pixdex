import { GALLERY_PATH, loadGallery, type Gallery } from './gallery';

/**
 * Loads the known-personalities gallery once per CLI command. A missing file means no known matching;
 * an unreadable or corrupt one warns once and also continues without it, so it never aborts an indexing run.
 */
export async function loadKnownGallery(
  warn: (message: string) => void = (m) => console.warn(m),
  file: string = GALLERY_PATH
): Promise<Gallery | undefined> {
  try {
    return await loadGallery(file);
  } catch (error) {
    warn(
      `Known gallery ${file} is unreadable (${error instanceof Error ? error.message : String(error)}); continuing without known matching. Rebuild it with build-known-gallery --full.`
    );
    return undefined;
  }
}
