import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { indiaDate } from '../src/insights/common';
import { readHeaders } from './helpers';
import { clearInsights } from './insights-helpers';

const PHOTOS = 2000;
/** The spec limit: 600,000 rows for 15,700 photos on the first visit of a day. */
const ROWS_PER_PHOTO = 38;
const TOPICS = ['time', 'gear', 'wildlife', 'people', 'places'];

type Statement = { sql: string; rows: number };

/** env.DB that records `meta.rows_read` of every statement (`first` is served by `all` so that it has a meta). */
function counting(db: D1Database, log: Statement[]): D1Database {
  const wrap = (sql: string, statement: D1PreparedStatement): any => {
    const all = async () => {
      const result = await statement.all();
      log.push({ sql, rows: result.meta.rows_read });
      return result;
    };
    return {
      bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
      all,
      first: async () => (await all()).results[0] ?? null,
      run: all,
    };
  };
  return { prepare: (sql: string) => wrap(sql, db.prepare(sql)) } as unknown as D1Database;
}

async function visit(): Promise<{ log: Statement[]; hydrated: number }> {
  const log: Statement[] = [];
  const bindings = { ...env, DB: counting(env.DB, log) };
  const date = indiaDate(new Date());
  let hydrated = 0;
  for (const path of [...TOPICS.map((t) => `/insights/${t}`), `/insights/on-this-day?date=${date}`]) {
    const res = await app.request(`https://example.com${path}`, { headers: readHeaders() }, bindings);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    if (body.facts) expect(body.facts.length, path).toBeGreaterThan(0);
    else hydrated = body.years.reduce((n: number, y: any) => n + y.photos.length, 0);
  }
  return { log, hydrated };
}

describe('insight cost on D1', () => {
  beforeAll(async () => {
    await clearInsights();
    const today = indiaDate(new Date());
    // 20 albums over 8 years, with the columns each fact needs; a part of the photos near today's month and day.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${PHOTOS - 1})
       INSERT INTO photos (id, content_hash, source, filename, subjects, album, date_time, aesthetic_score, camera_model, lens_model,
         focal_length, latitude, longitude, place, species, model_provider, model_name, search_text, search_primary, last_indexed)
       SELECT 'c' || i, 'ch' || i, 'local', i || '.jpg', '[]', 'Album ' || (i % 20),
         CASE WHEN i % 40 = 0 THEN (2018 + (i / 40) % 8) || substr(?, 5) || 'T06:00:00.000Z'
              ELSE strftime('%Y-%m-%dT%H:%M:%S.000Z', '2018-01-01', '+' || (i * 35) || ' hours') END,
         1 + (i % 90) / 10.0, 'Camera ' || (i / 700), 'Lens ' || (i % 3), 100 + (i % 6) * 100,
         CASE WHEN i % 9 = 0 THEN 11.0 + (i % 5) END, CASE WHEN i % 9 = 0 THEN 76.0 END, CASE WHEN i % 9 = 0 THEN 'Town ' || (i % 5) || ', IN' END,
         CASE WHEN i % 5 = 0 THEN '[{"common":"Species ' || (i % 8) || '","scientific":"s","score":0.9}]' ELSE '[]' END,
         'ollama', 'm', '', '', '2026-09-18T00:00:00.000Z' FROM n`
    )
      .bind(today)
      .run();
    for (let p = 0; p < 4; p++) {
      await env.DB.prepare(`INSERT INTO persons (id, name, created_at, owner_email) VALUES (?, ?, 'x', 'owner@example.com')`)
        .bind(`cp${p}`, `Person ${p}`)
        .run();
    }
    // Two faces on every fourth photo from the older half, so that someone is also "missed".
    for (const [offset, who] of [[0, "'cp' || (i % 4)"], [1, "'cp' || ((i + 1) % 4)"]] as const) {
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 249)
         INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, person_id, assign_status, created_at)
         SELECT 'cf${offset}-' || i, 'c' || (i * 4 + 1), 0.1, 0.1, 0.2, 0.2, 0.9, x'00', 'm', ${who}, 'confirmed', 'x' FROM n`
      ).run();
    }
  }, 60_000);

  it('reads at most 38 rows per photo on the first visit of a day, then almost nothing', async () => {
    const first = await visit();
    const rows = first.log.reduce((n, s) => n + s.rows, 0);
    console.log(`insights first visit: ${rows} rows for ${PHOTOS} photos (${(rows / PHOTOS).toFixed(1)} per photo)`);
    for (const s of first.log) console.log(`  ${s.rows}\t${s.sql.replace(/\s+/g, ' ').slice(0, 90)}`);
    expect(rows).toBeLessThanOrEqual(ROWS_PER_PHOTO * PHOTOS);

    const second = await visit();
    const cachedRows = second.log.reduce((n, s) => n + s.rows, 0);
    console.log(`insights cached visit: ${cachedRows} rows, ${second.hydrated} photos shown`);
    // Person names and On this day photos are loaded by key: a few rows each.
    expect(cachedRows).toBeLessThan(100 + second.hydrated * 4);
  }, 60_000);
});
