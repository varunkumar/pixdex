export const EMBEDDING_DIM = 512;

function normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (!Number.isFinite(n) || n === 0) throw new Error('invalid embedding');
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Decode a base64 little-endian float32 vector of exactly 512 floats, L2-normalised. */
export function embeddingFromBase64(b64: string): Float32Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error('invalid embedding');
  }
  if (bin.length !== EMBEDDING_DIM * 4) throw new Error('invalid embedding');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return normalise(embeddingFromBytes(bytes));
}

export function embeddingToBytes(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i], true);
  return out;
}

export function embeddingFromBytes(b: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
