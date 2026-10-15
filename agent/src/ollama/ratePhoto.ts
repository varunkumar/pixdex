import sharp from 'sharp';
import type { OllamaClient } from './client';

const RATING_PROMPT = `You are a demanding photo editor choosing images for a wildlife photographer's public Instagram feed. For this photo give:

1. score: how good the photo looks, 1 to 10. Judge only the picture itself:
- Is the main subject sharp and clearly visible (not blurred, not hidden behind branches, not tiny in the frame)?
- Is the light pleasing (not flat, harsh, murky or badly over/underexposed)?
- Is the composition strong (subject well placed, clean background, nothing distracting, nothing awkwardly cut off)?
- Is there something striking: behaviour, expression, atmosphere, colour?
Be strict, most photos are ordinary:
1-3: poor (blurry, dark, cluttered, subject barely visible, snapshot quality)
4-5: mediocre (record shot, acceptable but forgettable)
6: decent
7-8: good, would be proud to post
9-10: exceptional, portfolio quality (rare)

2. caption: a title for the photo in 3 to 4 words (e.g. "Leopard resting at dusk"). Describe what is shown. No place names, no hashtags, no quotes.

Reply with only a JSON object like {"score": 6, "caption": "Leopard resting at dusk"}. No commentary.`;

const RATING_MAX_DIMENSION = 1024;
const MAX_CAPTION_WORDS = 4;

export interface PhotoRating {
  /** 1-10; null when the model gave no usable score. */
  score: number | null;
  /** At most 4 words; null when the model gave none. */
  caption: string | null;
}

function parseScore(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n) || n < 1 || n > 10) return null;
  return Math.round(n * 10) / 10;
}

/** Trims a caption to at most 4 words and strips quotes and trailing punctuation. */
export function normalizeCaption(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const words = raw
    .replace(/["“”'`#]/g, '')
    .replace(/[.!?,;:]+$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_CAPTION_WORDS);
  return words.length ? words.join(' ') : null;
}

/** Extracts the score and caption from the model reply. */
export function parsePhotoRating(content: string): PhotoRating {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const data = JSON.parse(content.slice(start, end + 1)) as { score?: unknown; caption?: unknown };
      return { score: parseScore(data.score), caption: normalizeCaption(data.caption) };
    } catch {
      // fall through to the plain-text number fallback
    }
  }
  const number = content.match(/\b(10|[1-9])(?:\.\d+)?\b/)?.[0];
  return { score: number ? parseScore(number) : null, caption: null };
}

/** Asks the vision model how good the photo looks and for a short title. */
export async function ratePhoto(imagePath: string, client: OllamaClient): Promise<PhotoRating> {
  const bytes = await sharp(imagePath)
    .rotate()
    .resize(RATING_MAX_DIMENSION, RATING_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  // No reasoning phase: a number and a few words do not need it, and it keeps
  // a backfill over thousands of photos fast.
  const content = await client.chat(
    [{ role: 'user', content: RATING_PROMPT, images: [bytes.toString('base64')] }],
    { think: false }
  );
  return parsePhotoRating(content);
}
