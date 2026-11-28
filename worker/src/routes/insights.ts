import type { Context } from 'hono';
import type { Env } from '../types';
import { userOf } from '../access';
import { serializePhoto, type PhotoRow } from '../db/photos';
import { cached, indiaDate, ownedSql, periodStart } from '../insights/common';
import { blockStart, onThisDayBlock } from '../insights/onThisDay';
import { hydrateFacts, peopleFacts } from '../insights/people';
import { gearMainFacts, recipeBuild, withRecipe } from '../insights/gear';
import { placesFacts } from '../insights/places';
import { timeFacts } from '../insights/time';
import { wildlifeFacts } from '../insights/wildlife';
import type { Topic, TopicBuilder } from '../insights/types';

/** Each topic and the day offset of its 30-day cycle: 5 days apart, so that one visit calculates one part. */
const TILES: Record<Topic, { build: TopicBuilder; offset: number }> = {
  time: { build: timeFacts, offset: 0 },
  gear: { build: gearMainFacts, offset: 5 },
  wildlife: { build: wildlifeFacts, offset: 10 },
  people: { build: peopleFacts, offset: 15 },
  places: { build: placesFacts, offset: 20 },
};
/** The recipe is a second part of Gear with its own cycle: it halves the cost of the most costly day. */
const RECIPE_OFFSET = 25;

/** How far the browser's date may be from the India date (time zones, and a page left open over midnight). */
const MAX_DATE_DRIFT_DAYS = 2;

/** `GET /insights/:topic`: the caller's facts for one topic, calculated once per 30-day cycle. */
export async function insightsRoute(c: Context<{ Bindings: Env }>) {
  const topic = c.req.param('topic') as Topic;
  const tile = Object.hasOwn(TILES, topic) ? TILES[topic] : undefined;
  if (!tile) return c.json({ error: 'Unknown topic' }, 404);
  const { email } = userOf(c);
  const db = c.env.DB;
  const day = indiaDate(new Date());
  let facts = await cached(db, email, topic, periodStart(day, tile.offset), day, () => tile.build(db, email, day), (f) => f.length === 0);
  if (topic === 'gear') {
    const recipe = await cached(
      db, email, 'gear-recipe', periodStart(day, RECIPE_OFFSET), day, () => recipeBuild(db, email, day), (r) => r.small
    );
    facts = withRecipe(facts, recipe.facts);
  }
  return c.json({ day, facts: await hydrateFacts(db, email, facts) });
}

/** A part that is newer than this stays: repeated clicks cannot spend the daily read budget. */
const REFRESH_AFTER_MINUTES = 5;

/**
 * `POST /insights/refresh`: forgets the caller's cached parts, so that the next reads calculate them again. It
 * touches only the caller's own rows (primary key prefix), so any viewer may call it. One delete.
 */
export async function refreshInsightsRoute(c: Context<{ Bindings: Env }>) {
  const { email } = userOf(c);
  const before = new Date(Date.now() - REFRESH_AFTER_MINUTES * 60_000).toISOString();
  const result = await c.env.DB.prepare('DELETE FROM insights_cache WHERE email = ? AND computed_at < ?').bind(email, before).run();
  return c.json({ removed: result.meta.changes });
}

function acceptedDate(date: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) return false;
  return Math.abs(t - Date.parse(`${today}T00:00:00Z`)) <= MAX_DATE_DRIFT_DAYS * 86_400_000;
}

/**
 * `GET /insights/on-this-day?date=`: photos from the browser's date ±2 days in earlier years. One calculation
 * covers a 7-day block. The cache holds ids only; every read loads them by primary key and checks ownership again, so deleted or moved photos drop out.
 */
export async function onThisDayRoute(c: Context<{ Bindings: Env }>) {
  const date = c.req.query('date') ?? '';
  if (!acceptedDate(date, indiaDate(new Date()))) return c.json({ error: 'date must be YYYY-MM-DD, near today' }, 400);
  const { email } = userOf(c);
  const start = blockStart(date);
  const cache = await cached(
    c.env.DB, email, 'on-this-day', start, date, async () => ({ days: await onThisDayBlock(c.env.DB, email, start) }), () => false
  );
  const years = cache.days[date] ?? [];
  const wanted = years.flatMap((y) => y.ids);
  if (wanted.length === 0) return c.json({ date, years: [] });
  const rows = await c.env.DB.prepare(`SELECT * FROM photos WHERE id IN (SELECT value FROM json_each(?)) AND ${ownedSql('+album')}`)
    .bind(JSON.stringify(wanted), email)
    .all<PhotoRow>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  return c.json({
    date,
    years: years
      .map(({ year, ids }) => ({
        year,
        photos: ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [serializePhoto(row, true)] : [];
        }),
      }))
      .filter((y) => y.photos.length > 0),
  });
}
