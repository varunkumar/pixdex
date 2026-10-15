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

2. caption: a short title for the photo. It must be a complete phrase of 2 to 4 words, never more than 4 words (e.g. "Leopard resting at dusk", "Osprey with fish", "Mother and daughter embrace"). Choose a phrase that is naturally short; do not write a longer phrase and cut it. It must not end on a connecting word such as by, with, and, on, in, at or of. Describe what is shown. No place names, no hashtags, no quotes.

Reply with only a JSON object like {"score": 6, "caption": "Leopard resting at dusk"}. No commentary.`;

const RATING_MAX_DIMENSION = 1024;
const MAX_CAPTION_WORDS = 4;
// A caption over the limit is never cut down; the model is asked again instead.
const MAX_ATTEMPTS = 3;

export interface PhotoRating {
  /** 1-10; null when the model gave no usable score. */
  score: number | null;
  /** As written by the model, at most 4 words; null when none was usable. */
  caption: string | null;
}

function parseScore(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n) || n < 1 || n > 10) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Returns the caption as the model wrote it (whitespace and surrounding quotes
 * aside), or null when it is empty or longer than 4 words. Over-long captions
 * are rejected, not shortened: a cut phrase reads wrong ("Woman and child by").
 */
export function normalizeCaption(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const caption = raw.trim().replace(/^["“”'`]+|["“”'`]+$/g, '').trim();
  const words = caption.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_CAPTION_WORDS) return null;
  return caption;
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
  let rating: PhotoRating = { score: null, caption: null };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const content = await client.chat(
      [{ role: 'user', content: RATING_PROMPT, images: [bytes.toString('base64')] }],
      { think: false }
    );
    const parsed = parsePhotoRating(content);
    rating = { score: parsed.score ?? rating.score, caption: parsed.caption };
    if (rating.score !== null && rating.caption !== null) break;
  }
  return rating;
}
