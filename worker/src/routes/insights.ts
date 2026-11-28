import type { Context } from 'hono';
import type { Env } from '../types';
import { userOf } from '../access';
import { serializePhoto, type PhotoRow } from '../db/photos';
import { cached, indiaDate, ownedSql } from '../insights/common';
import { onThisDayIds } from '../insights/onThisDay';
import { hydrateFacts, peopleFacts } from '../insights/people';
import { gearFacts } from '../insights/gear';
import { placesFacts } from '../insights/places';
import { timeFacts } from '../insights/time';
import { wildlifeFacts } from '../insights/wildlife';
import type { Topic, TopicBuilder } from '../insights/types';

const BUILDERS: Record<Topic, TopicBuilder> = { time: timeFacts, gear: gearFacts, wildlife: wildlifeFacts, people: peopleFacts, places: placesFacts };

/** How far the browser's date may be from the India date (time zones, and a page left open over midnight). */
const MAX_DATE_DRIFT_DAYS = 2;

/** `GET /insights/:topic`: the caller's facts for one topic, calculated once per India day. */
export async function insightsRoute(c: Context<{ Bindings: Env }>) {
  const topic = c.req.param('topic') as Topic;
  const build = Object.hasOwn(BUILDERS, topic) ? BUILDERS[topic] : undefined;
  if (!build) return c.json({ error: 'Unknown topic' }, 404);
  const { email } = userOf(c);
  const day = indiaDate(new Date());
  const facts = await cached(c.env.DB, email, topic, day, () => build(c.env.DB, email, day));
  return c.json({ day, facts: await hydrateFacts(c.env.DB, email, facts) });
}

function acceptedDate(date: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) return false;
  return Math.abs(t - Date.parse(`${today}T00:00:00Z`)) <= MAX_DATE_DRIFT_DAYS * 86_400_000;
}

/**
 * `GET /insights/on-this-day?date=`: photos from the browser's date ±2 days in earlier years. The cache holds ids
 * only; every read loads them by primary key and checks ownership again, so deleted or moved photos drop out.
 */
export async function onThisDayRoute(c: Context<{ Bindings: Env }>) {
  const date = c.req.query('date') ?? '';
  if (!acceptedDate(date, indiaDate(new Date()))) return c.json({ error: 'date must be YYYY-MM-DD, near today' }, 400);
  const { email } = userOf(c);
  const cache = await cached(c.env.DB, email, 'on-this-day', date, async () => ({ years: await onThisDayIds(c.env.DB, email, date) }));
  const wanted = cache.years.flatMap((y) => y.ids);
  if (wanted.length === 0) return c.json({ date, years: [] });
  const rows = await c.env.DB.prepare(`SELECT * FROM photos WHERE id IN (SELECT value FROM json_each(?)) AND ${ownedSql('+album')}`)
    .bind(JSON.stringify(wanted), email)
    .all<PhotoRow>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  return c.json({
    date,
    years: cache.years
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
