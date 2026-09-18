import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';

export function isImageFile(filename: string): boolean {
  const basename = path.basename(filename);
  if (basename.startsWith('._')) {
    return false;
  }
  const mimeType = mime.lookup(filename);
  return mimeType ? mimeType.startsWith('image/') : false;
}

export async function scanDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}
