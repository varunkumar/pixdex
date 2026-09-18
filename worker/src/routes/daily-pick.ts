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
  'id, content_hash, subjects, description, season, environment, suggested_caption, suggested_hashtags, instagram_suggested';

function isEligible(row: PhotoRow): boolean {
  if (!row.instagram_suggested) return true;
  const daysSince = (Date.now() - new Date(row.instagram_suggested).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > 90;
}

function score(row: PhotoRow): number {
  const subjects: string[] = row.subjects ? JSON.parse(row.subjects) : [];
  let s = subjects.length * 2;
  s += (row.description ?? '').split(' ').filter(Boolean).length * 0.1;

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
  const reason = `This photo was selected because it features ${
    subjects.length > 0 ? subjects.join(', ') : 'interesting subjects'
  } in a ${row.environment ?? 'natural'} setting${row.season ? ` during ${row.season}` : ''}.`;

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

  const eligible = all.results.filter(isEligible);
  const pool = eligible.length > 0 ? eligible : all.results;

  const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));

  const now = new Date().toISOString();
  await c.env.DB.prepare('UPDATE photos SET instagram_suggested = ? WHERE id = ?').bind(now, best.id).run();
  best.instagram_suggested = now;

  return c.json(buildResponse(best));
}
