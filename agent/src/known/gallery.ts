import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface KnownPerson {
  id: string;
  name: string;
  aliases: string[];
}

export interface GalleryPerson extends KnownPerson {
  refs: Float32Array[];
}

export interface Gallery {
  model: string;
  people: GalleryPerson[];
}

export const EMBEDDING_DIM = 512;

/** Local, uncommitted (agent/.index-state/ is gitignored). */
export const GALLERY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.index-state/known-gallery.json'
);

/** Decodes a base64 little-endian float32 vector of 512 values and L2-normalises it. Throws on bad input. */
export function decodeEmbedding(b64: string): Float32Array {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.byteLength !== EMBEDDING_DIM * 4) {
    throw new Error(`Embedding must be ${EMBEDDING_DIM * 4} bytes, got ${bytes.byteLength}`);
  }
  const out = new Float32Array(EMBEDDING_DIM);
  let sum = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const v = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(v)) throw new Error('Embedding contains a non-finite value');
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new Error('Embedding has zero norm');
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] /= norm;
  return out;
}

function encodeEmbedding(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

export async function saveGallery(file: string, g: Gallery): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const json = {
    model: g.model,
    people: g.people.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, refs: p.refs.map(encodeEmbedding) })),
  };
  await fs.writeFile(file, JSON.stringify(json));
}

export async function loadGallery(file: string): Promise<Gallery | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const json = JSON.parse(raw) as {
    model: string;
    people: { id: string; name: string; aliases: string[]; refs: string[] }[];
  };
  return {
    model: json.model,
    people: json.people.map((p) => ({
      id: p.id,
      name: p.name,
      aliases: p.aliases,
      refs: p.refs.map(decodeEmbedding),
    })),
  };
}
