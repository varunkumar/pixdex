import type { Context } from 'hono';
import type { Env } from '../types';

interface PhotoRow {
  id: string;
  subjects: string;
  description: string;
  season: string | null;
  environment: string | null;
  suggested_caption: string;
  suggested_hashtags: string;
  instagram_suggested: string | null;
  [key: string]: unknown;
}

const SEASON_MONTHS: Record<string, number[]> = {
  winter: [11, 0, 1],
  spring: [2, 3, 4],
  summer: [5, 6, 7],
  autumn: [8, 9, 10],
};

function isEligible(row: PhotoRow): boolean {
  if (!row.instagram_suggested) return true;
  const daysSince = (Date.now() - new Date(row.instagram_suggested).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > 90;
}

function score(row: PhotoRow): number {
  const subjects: string[] = JSON.parse(row.subjects);
  let s = subjects.length * 2;
  s += row.description.split(' ').filter(Boolean).length * 0.1;

  if (row.season) {
    const months = SEASON_MONTHS[row.season.toLowerCase()];
    if (months?.includes(new Date().getMonth())) {
      s += 5;
    }
  }
  return s;
}

export async function dailyPickRoute(c: Context<{ Bindings: Env }>) {
  const all = await c.env.DB.prepare('SELECT * FROM photos').all<PhotoRow>();
  if (all.results.length === 0) {
    return c.text('No photos available', 404);
  }

  const eligible = all.results.filter(isEligible);
  const pool = eligible.length > 0 ? eligible : all.results;

  const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));

  await c.env.DB.prepare('UPDATE photos SET instagram_suggested = ? WHERE id = ?')
    .bind(new Date().toISOString(), best.id)
    .run();

  const subjects: string[] = JSON.parse(best.subjects);
  const reason = `This photo was selected because it features ${
    subjects.length > 0 ? subjects.join(', ') : 'interesting subjects'
  } in a ${best.environment ?? 'natural'} setting${best.season ? ` during ${best.season}` : ''}.`;

  return c.json({
    photo: { ...best, subjects },
    reason,
    suggestedCaption: best.suggested_caption,
    suggestedHashtags: JSON.parse(best.suggested_hashtags),
  });
}
