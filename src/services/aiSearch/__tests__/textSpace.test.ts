import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureTextSpace, textSpaceFromLuma } from '../textSpace';

const SIZE = 48;

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function build(fn: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) out.push(fn(x, y));
  return out;
}

describe('textSpaceFromLuma', () => {
  it('scores a uniform image as fully calm', () => {
    expect(textSpaceFromLuma(build(() => 128), SIZE).score).toBe(1);
  });

  it('picks the flat side when the other 60 percent is noisy', () => {
    const r = rng(1);
    const noise = build(() => (r() < 0.5 ? 0 : 255));
    const luma = build((x, y) => (x < SIZE * 0.6 ? noise[y * SIZE + x] : 128));
    const result = textSpaceFromLuma(luma, SIZE);
    expect(result.side).toBe('right');
    expect(result.score).toBeGreaterThan(0.9);
  });

  it('scores an all-noise image near zero', () => {
    const r = rng(2);
    const result = textSpaceFromLuma(build(() => r() * 255), SIZE);
    expect(result.score).toBeLessThan(0.1);
  });
});

describe('measureTextSpace', () => {
  let created = 0;
  let mode: 'error' | 'load' = 'error';

  beforeEach(() => {
    created = 0;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      set src(_v: string) {
        created++;
        queueMicrotask(() => (mode === 'load' ? this.onload?.() : this.onerror?.()));
      }
    }
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage: () => {},
          getImageData: () => ({ data: new Uint8ClampedArray(SIZE * SIZE * 4).fill(128) }),
        }) as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves score 0 when the image fails to load, and does not cache it', async () => {
    mode = 'error';
    const url = '/api/thumbnails/bad';
    await expect(measureTextSpace(url)).resolves.toMatchObject({ score: 0 });
    mode = 'load';
    const retry = await measureTextSpace(url);
    expect(retry.score).toBe(1);
    expect(created).toBe(2);
  });

  it('caches a successful measurement by url', async () => {
    mode = 'load';
    const url = '/api/thumbnails/good';
    const first = await measureTextSpace(url);
    const second = await measureTextSpace(url);
    expect(second).toEqual(first);
    expect(created).toBe(1);
  });

  it('resolves score 0 when the canvas read throws', async () => {
    mode = 'load';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('tainted');
    });
    await expect(measureTextSpace('/api/thumbnails/taint')).resolves.toEqual({
      side: 'top',
      score: 0,
    });
  });
});
