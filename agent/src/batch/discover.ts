import fs from 'node:fs/promises';
import path from 'node:path';
import { isImageFile, scanDirectory } from '../scanner';

export interface DiscoveredAlbum {
  name: string;
  albumDir: string;
  processedDir: string;
  imageCount: number;
}

export interface Discovery {
  albums: DiscoveredAlbum[];
  /** Inputs that could not be read (e.g. an unmounted disk). */
  unavailable: string[];
}

const PROCESSED = 'processed';
const SKIPPED_ALBUMS = new Set(['unprocessed']);

async function subdirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function describeAlbum(albumDir: string): Promise<DiscoveredAlbum | null> {
  const children = await subdirs(albumDir);
  const processed = children.find((name) => name.toLowerCase() === PROCESSED);
  if (!processed) return null;
  const processedDir = path.join(albumDir, processed);
  const imageCount = (await scanDirectory(processedDir)).filter(isImageFile).length;
  return { name: path.basename(albumDir), albumDir, processedDir, imageCount };
}

/**
 * Each input is either a root holding album folders (`<root>/<album>/Processed`)
 * or a single album folder that itself has a Processed folder. `Unprocessed`
 * folders and albums without a Processed folder are never returned.
 */
export async function discoverAlbums(inputs: string[]): Promise<Discovery> {
  const albums: DiscoveredAlbum[] = [];
  const unavailable: string[] = [];

  for (const input of inputs) {
    try {
      const asAlbum = await describeAlbum(input);
      if (asAlbum) {
        albums.push(asAlbum);
        continue;
      }
      for (const name of (await subdirs(input)).sort()) {
        if (SKIPPED_ALBUMS.has(name.toLowerCase())) continue;
        const album = await describeAlbum(path.join(input, name));
        if (album) albums.push(album);
      }
    } catch {
      unavailable.push(input);
    }
  }

  return { albums, unavailable };
}
