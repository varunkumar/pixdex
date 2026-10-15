import { describe, expect, it } from 'vitest';
import { normalizeCaption, parsePhotoRating } from '../src/ollama/ratePhoto';

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
  it('caps at 4 words and strips quotes, hashes and trailing punctuation', () => {
    expect(normalizeCaption('"A big leopard resting on a tree branch."')).toBe('A big leopard resting');
    expect(normalizeCaption('#Golden hour.')).toBe('Golden hour');
  });

  it('drops a connector left dangling by the 4-word cut', () => {
    expect(normalizeCaption('Woman and child by the river')).toBe('Woman and child');
  });

  it('returns null for empty or non-string input', () => {
    expect(normalizeCaption('  ')).toBeNull();
    expect(normalizeCaption(undefined)).toBeNull();
  });
});
