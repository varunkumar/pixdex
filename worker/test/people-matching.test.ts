import { describe, it, expect } from 'vitest';
import {
  EMBEDDING_DIM,
  embeddingFromBase64,
  embeddingToBytes,
  embeddingFromBytes,
} from '../src/people/embedding';
import {
  AUTO_THRESHOLD,
  SUGGEST_THRESHOLD,
  MIN_DET_SCORE,
  MIN_FACE_SIDE,
  MATCHABLE_SQL,
  isMatchable,
  bestScore,
  classify,
  clusterFaces,
} from '../src/people/matching';

function toB64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unit(i: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[i] = 1;
  return v;
}

function norm(v: Float32Array): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

describe('embedding codec', () => {
  it('base64 round trip keeps the vector', () => {
    const v = unit(3);
    const out = embeddingFromBase64(toB64(v));
    expect(Array.from(out)).toEqual(Array.from(v));
  });

  it('embeddingFromBytes rejects the wrong byte length', () => {
    expect(() => embeddingFromBytes(new Uint8Array(10))).toThrow('invalid embedding');
    expect(() => embeddingFromBytes(new Uint8Array(EMBEDDING_DIM * 4 + 4))).toThrow('invalid embedding');
  });

  it('embeddingFromBytes decodes a misaligned view', () => {
    const v = unit(7);
    const raw = embeddingToBytes(v);
    const padded = new Uint8Array(raw.length + 1);
    padded.set(raw, 1);
    const view = padded.subarray(1);
    expect(view.byteOffset % 4).not.toBe(0);
    expect(Array.from(embeddingFromBytes(view))).toEqual(Array.from(v));
  });

  it('rejects a vector of the wrong length', () => {
    expect(() => embeddingFromBase64(toB64(new Float32Array(10)))).toThrow('invalid embedding');
  });

  it('normalises on decode', () => {
    const v = new Float32Array(EMBEDDING_DIM).fill(3);
    const out = embeddingFromBase64(toB64(v));
    expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);
  });

  it('bytes round trip is exact', () => {
    const v = new Float32Array(EMBEDDING_DIM).map((_, i) => Math.sin(i) / 7);
    const out = embeddingFromBytes(embeddingToBytes(v));
    expect(Array.from(out)).toEqual(Array.from(v));
    const buf = embeddingToBytes(v).buffer.slice(0);
    expect(Array.from(embeddingFromBytes(buf as ArrayBuffer))).toEqual(Array.from(v));
  });
});

describe('matching', () => {
  it('classify at 0.5 is auto, at 0.4 is suggest, at 0.399 is none', () => {
    expect(classify(AUTO_THRESHOLD)).toBe('auto');
    expect(classify(SUGGEST_THRESHOLD)).toBe('suggest');
    expect(classify(0.399)).toBe('none');
  });

  it('bestScore takes the maximum over references and returns -1 for none', () => {
    const f = unit(0);
    expect(bestScore(f, [unit(1), unit(0)])).toBeCloseTo(1);
    expect(bestScore(f, [])).toBe(-1);
  });

  it('clusterFaces groups two close vectors and separates an orthogonal one', () => {
    const a = unit(0);
    const b = unit(0);
    b[1] = 0.1;
    const c = unit(5);
    const out = clusterFaces([
      { id: 'a', embedding: a },
      { id: 'b', embedding: b },
      { id: 'c', embedding: c },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].sort()).toEqual(['a', 'b']);
    expect(out[1]).toEqual(['c']);
  });

  it('clusterFaces returns the larger group first', () => {
    const out = clusterFaces([
      { id: 'x', embedding: unit(7) },
      { id: 'p', embedding: unit(0) },
      { id: 'q', embedding: unit(0) },
      { id: 'r', embedding: unit(0) },
    ]);
    expect(out[0].sort()).toEqual(['p', 'q', 'r']);
    expect(out[1]).toEqual(['x']);
  });

  it('isMatchable rejects a low score and a tiny box and accepts a normal face', () => {
    expect(isMatchable({ detScore: 0.5, w: 0.2, h: 0.2 })).toBe(false);
    expect(isMatchable({ detScore: 0.9, w: 0.02, h: 0.2 })).toBe(false);
    expect(isMatchable({ detScore: 0.9, w: 0.2, h: 0.02 })).toBe(false);
    expect(isMatchable({ detScore: 0.9, w: 0.2, h: 0.2 })).toBe(true);
  });

  it('MATCHABLE_SQL uses the same constants', () => {
    expect(MATCHABLE_SQL).toContain(String(MIN_DET_SCORE));
    expect(MATCHABLE_SQL).toContain(String(MIN_FACE_SIDE));
    expect(MATCHABLE_SQL).toContain('det_score');
    expect(MATCHABLE_SQL).toContain('bbox_w');
    expect(MATCHABLE_SQL).toContain('bbox_h');
  });

  it('clusterFaces follows a slowly drifting set and stays linear in cluster size', () => {
    // 150 near-identical vectors form one cluster.
    const same = Array.from({ length: 150 }, (_, i) => {
      const v = unit(0);
      v[1 + (i % 20)] = 0.05;
      return { id: `s${i}`, embedding: v };
    });
    const t = performance.now();
    const out = clusterFaces(same);
    expect(performance.now() - t).toBeLessThan(200);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(150);

    // Slow drift in the e0/e1 plane (3 degrees per step) stays together while the centroid tracks it,
    // and a vector at 90 degrees is separate.
    const drift = Array.from({ length: 20 }, (_, i) => {
      const v = new Float32Array(EMBEDDING_DIM);
      v[0] = Math.cos((i * 3 * Math.PI) / 180);
      v[1] = Math.sin((i * 3 * Math.PI) / 180);
      return { id: `d${i}`, embedding: v };
    });
    const far = unit(1);
    far[0] = 0;
    const res = clusterFaces([...drift, { id: 'far', embedding: unit(9) }]);
    expect(res[0]).toHaveLength(20);
    expect(res[1]).toEqual(['far']);
  });
});
