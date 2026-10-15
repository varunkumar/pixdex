import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OllamaClient } from '../src/ollama/client';
import { normalizeCaption, parsePhotoRating, ratePhoto } from '../src/ollama/ratePhoto';

describe('parsePhotoRating', () => {
  it('reads score and caption from JSON, including fenced output', () => {
    expect(parsePhotoRating('{"score": 7, "caption": "Leopard resting at dusk"}')).toEqual({
      score: 7,
      caption: 'Leopard resting at dusk',
    });
    expect(parsePhotoRating('```json\n{"score": 6.5, "caption": "Owl"}\n```')).toEqual({ score: 6.5, caption: 'Owl' });
  });

  it('keeps a valid caption when the score is unusable, and vice versa', () => {
    expect(parsePhotoRating('{"score": 15, "caption": "Tiger"}')).toEqual({ score: null, caption: 'Tiger' });
    expect(parsePhotoRating('{"score": 8}')).toEqual({ score: 8, caption: null });
  });

  it('falls back to the first number in plain text', () => {
    expect(parsePhotoRating('I would give it a 8 out of 10')).toEqual({ score: 8, caption: null });
    expect(parsePhotoRating('no idea')).toEqual({ score: null, caption: null });
  });
});

describe('normalizeCaption', () => {
  it('keeps a caption of up to 4 words exactly as written', () => {
    expect(normalizeCaption('Woman and child by')).toBe('Woman and child by');
    expect(normalizeCaption('  "Golden hour"  ')).toBe('Golden hour');
  });

  it('rejects a caption over 4 words instead of cutting it', () => {
    expect(normalizeCaption('A big leopard resting on a tree branch')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(normalizeCaption('  ')).toBeNull();
    expect(normalizeCaption(undefined)).toBeNull();
  });
});

describe('ratePhoto', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-rate-'));
    file = path.join(dir, 'a.jpg');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(file);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('asks again when the caption is over 4 words and uses the compliant answer', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce('{"score": 6, "caption": "Leopard resting on a tree branch"}')
      .mockResolvedValueOnce('{"score": 7, "caption": "Leopard on branch"}');

    const rating = await ratePhoto(file, { chat } as unknown as OllamaClient);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(rating).toEqual({ score: 7, caption: 'Leopard on branch' });
  });

  it('gives no caption (and keeps the score) when the model never complies', async () => {
    const chat = vi.fn().mockResolvedValue('{"score": 5, "caption": "A leopard resting on a tree branch"}');

    const rating = await ratePhoto(file, { chat } as unknown as OllamaClient);

    expect(chat).toHaveBeenCalledTimes(3);
    expect(rating).toEqual({ score: 5, caption: null });
  });
});
