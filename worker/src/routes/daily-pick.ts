import type { Context } from 'hono';
import type { Env } from '../types';
import { serializePhoto, type PhotoRow } from '../db/photos';

const SEASON_MONTHS: Record<string, number[]> = {
  winter: [11, 0, 1],
  spring: [2, 3, 4],
  summer: [5, 6, 7],
  autumn: [8, 9, 10],
};

// Only the columns the route actually reads, to keep D1 row-read cost down
// (this endpoint is unauthenticated and can be called by anyone).
const SELECT_COLUMNS =
  'id, filename, content_hash, subjects, description, season, environment, suggested_caption, suggested_hashtags, instagram_suggested, source, drive_file_id, aesthetic_score, short_caption, has_watermark';

function isEligible(row: PhotoRow): boolean {
  if (!row.instagram_suggested) return true;
  const daysSince = (Date.now() - new Date(row.instagram_suggested).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > 90;
}

// The pick is for nature, wildlife and landscapes, so anything showing a person
// is out. The index has no explicit "people" field, so match the model's
// subjects and description text. "portrait" is left out on purpose: it is
// common for animal portraits.
const HUMAN_TERMS =
  /\b(person|people|persons|human|humans|man|men|woman|women|boy|boys|girl|girls|child|children|kid|kids|baby|toddler|infant|adult|tourist|tourists|visitor|visitors|photographer|photographers|couple|family|crowd|selfie|villager|villagers|farmer|farmers|fisherman|fishermen|guide|driver|ranger|rider|hiker|trekker|bride|groom)\b/i;

function hasHuman(row: PhotoRow): boolean {
  return HUMAN_TERMS.test(`${row.subjects ?? ''} ${row.description ?? ''}`);
}

// A photo must be rated at least this well (1-10) to be considered a "good" pick.
const MIN_GOOD_AESTHETIC = 7;

function score(row: PhotoRow): number {
  const subjects: string[] = row.subjects ? JSON.parse(row.subjects) : [];
  // Looks dominate; subject count and description length only break ties
  // between similarly rated photos (and rank photos that are not rated yet).
  let s = (row.aesthetic_score ?? 0) * 10;
  s += Math.min(subjects.length, 5) * 0.5;
  s += Math.min((row.description ?? '').split(' ').filter(Boolean).length, 60) * 0.02;

  if (row.season) {
    const months = SEASON_MONTHS[row.season.toLowerCase()];
    if (months?.includes(new Date().getMonth())) {
      s += 5;
    }
  }
  return s;
}

function buildResponse(row: PhotoRow) {
  const subjects: string[] = row.subjects ? JSON.parse(row.subjects) : [];
  const looks = row.aesthetic_score != null ? ` It rated ${row.aesthetic_score.toFixed(1)}/10 for visual quality.` : '';
  const reason = `This photo was selected because it features ${
    subjects.length > 0 ? subjects.join(', ') : 'interesting subjects'
  } in a ${row.environment ?? 'natural'} setting${row.season ? ` during ${row.season}` : ''}.${looks}`;

  return {
    photo: serializePhoto(row),
    reason,
    suggestedCaption: row.suggested_caption,
    suggestedHashtags: row.suggested_hashtags ? JSON.parse(row.suggested_hashtags) : [],
  };
}

export async function dailyPickRoute(c: Context<{ Bindings: Env }>) {
  const today = new Date().toISOString().slice(0, 10);

  // Idempotent-per-day: if a photo was already picked today, return it again
  // instead of re-scanning and re-picking (and re-writing) on every call.
  const alreadyPicked = await c.env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM photos WHERE instagram_suggested LIKE ? ORDER BY instagram_suggested DESC LIMIT 1`
  )
    .bind(`${today}%`)
    .first<PhotoRow>();

  if (alreadyPicked) {
    return c.json(buildResponse(alreadyPicked));
  }

  const all = await c.env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM photos`).all<PhotoRow>();
  if (all.results.length === 0) {
    return c.text('No photos available', 404);
  }

  const natural = all.results.filter((r) => !hasHuman(r));
  if (natural.length === 0) {
    return c.text('No photos available', 404);
  }

  const eligible = natural.filter(isEligible);
  const candidates = eligible.length > 0 ? eligible : natural;

  // Prefer photos rated as good-looking; if none qualify, take the best rated
  // ones; if nothing has been rated yet, fall back to every candidate.
  const rated = candidates.filter((r) => r.aesthetic_score != null);
  const good = rated.filter((r) => (r.aesthetic_score ?? 0) >= MIN_GOOD_AESTHETIC);
  const pool = good.length > 0 ? good : rated.length > 0 ? rated : candidates;

  const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));

  const now = new Date().toISOString();
  await c.env.DB.prepare('UPDATE photos SET instagram_suggested = ? WHERE id = ?').bind(now, best.id).run();
  best.instagram_suggested = now;

  return c.json(buildResponse(best));
}
