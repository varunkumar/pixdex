import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { indiaDate } from '../src/insights/common';
import { readHeaders } from './helpers';
import { clearInsights } from './insights-helpers';

const OTHER = 'other@example.com';
const TOPICS = ['time', 'gear', 'wildlife', 'people', 'places'];

type Read = { path: string; sql: string; params: unknown[]; rows: number };

/** env.DB that records each read statement, its values and `meta.rows_read`. */
function recording(db: D1Database, path: string, log: Read[]): D1Database {
  const wrap = (sql: string, params: unknown[], statement: D1PreparedStatement): any => {
    const all = async () => {
      const result = await statement.all();
      if (!sql.startsWith('INSERT')) log.push({ path, sql, params, rows: result.meta.rows_read });
      return result;
    };
    return {
      bind: (...values: unknown[]) => wrap(sql, values, statement.bind(...values)),
      all,
      first: async () => (await all()).results[0] ?? null,
      run: all,
    };
  };
  return { prepare: (sql: string) => wrap(sql, [], db.prepare(sql)) } as unknown as D1Database;
}

/** Every dashboard answer for the owner, calculated fresh. */
async function visit(): Promise<{ bodies: Record<string, unknown>; log: Read[] }> {
  await env.DB.prepare('DELETE FROM insights_cache').run();
  const log: Read[] = [];
  const bodies: Record<string, unknown> = {};
  for (const path of [...TOPICS.map((t) => `/insights/${t}`), `/insights/on-this-day?date=${indiaDate(new Date())}`]) {
    const res = await app.request(`https://example.com${path}`, { headers: readHeaders() }, { ...env, DB: recording(env.DB, path, log) });
    expect(res.status).toBe(200);
    bodies[path] = await res.json();
  }
  return { bodies, log };
}

/** `count` photos with every column a fact uses, in `albums` albums named `prefix N`. */
async function seed(prefix: string, count: number, albums: number): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${count - 1})
     INSERT INTO photos (id, content_hash, source, filename, subjects, album, date_time, aesthetic_score, camera_model, lens_model,
       focal_length, latitude, longitude, place, species, model_provider, model_name, search_text, search_primary, last_indexed)
     SELECT ?1 || i, ?1 || 'h' || i, 'local', i || '.jpg', '[]', ?1 || ' ' || (i % ${albums}),
       CASE WHEN i % 40 = 0 THEN (2018 + (i / 40) % 8) || substr(?2, 5) || 'T06:00:00.000Z'
            ELSE strftime('%Y-%m-%dT%H:%M:%S.000Z', '2018-01-01', '+' || (i * 35) || ' hours') END,
       1 + (i % 90) / 10.0, ?1 || ' camera ' || (i / 400), 'Lens ' || (i % 3), 100 + (i % 6) * 100,
       CASE WHEN i % 5 = 0 THEN 11.0 + (i % 5) END, CASE WHEN i % 5 = 0 THEN 76.0 END, CASE WHEN i % 5 = 0 THEN ?1 || ' town, IN' END,
       '[{"common":"' || ?1 || ' species ' || (i % 8) || '","scientific":"s","score":0.9}]',
       'ollama', 'm', '', '', '2026-09-18T00:00:00.000Z' FROM n`
  )
    .bind(prefix, indiaDate(new Date()))
    .run();
}

/** Two faces on each of the first 60 photos of `prefix`, for two people of `owner`. */
async function seedPeople(prefix: string, owner: string): Promise<void> {
  for (const k of [0, 1]) {
    await env.DB.prepare(`INSERT INTO persons (id, name, created_at, owner_email) VALUES (?, ?, 'x', ?)`)
      .bind(`${prefix}p${k}`, `${prefix} person ${k}`, owner)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 59)
       INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, person_id, assign_status, created_at)
       SELECT ?1 || 'f${k}-' || i, ?1 || i, 0.1, 0.1, 0.2, 0.2, 0.9, x'00', 'm', ?1 || 'p${k}', 'confirmed', 'x' FROM n`
    )
      .bind(prefix)
      .run();
  }
}

describe("insights read only the caller's photos", () => {
  let alone: Awaited<ReturnType<typeof visit>>;
  let crowded: Awaited<ReturnType<typeof visit>>;

  beforeAll(async () => {
    await clearInsights();
    await seed('mine', 600, 6);
    await seedPeople('mine', 'owner@example.com');
    alone = await visit();
    // A second user with five times as many photos, same lenses and dates; one of their albums is shared with the owner.
    await seed('theirs', 3000, 30);
    await env.DB.prepare(`UPDATE albums SET owner_email = ? WHERE name LIKE 'theirs %'`).bind(OTHER).run();
    await env.DB.prepare(`UPDATE albums SET shared_with = '["owner@example.com"]' WHERE name = 'theirs 0'`).run();
    await seedPeople('theirs', OTHER);
    crowded = await visit();
  }, 60_000);

  it("another user's photos, shared or not, change no answer", () => {
    expect(crowded.bodies).toEqual(alone.bodies);
    expect(JSON.stringify(crowded.bodies)).not.toContain('theirs');
    for (const topic of TOPICS) expect((alone.bodies[`/insights/${topic}`] as any).facts.length, topic).toBeGreaterThan(0);
  });

  it('no statement scans the photos or faces table', async () => {
    for (const { sql, params, path } of crowded.log) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
      const text = plan.results.map((r) => r.detail).join('\n');
      expect(text, `${path}: ${sql.slice(0, 80)}`).not.toMatch(/SCAN (photos|p|ph|f|faces)\b/);
    }
  });

  it("a topic reads about the same rows however many photos other users have", () => {
    const rows = (log: Read[], path: string) => log.filter((r) => r.path === path).reduce((n, r) => n + r.rows, 0);
    for (const topic of TOPICS) {
      const path = `/insights/${topic}`;
      console.log(`${topic}: ${rows(alone.log, path)} rows alone, ${rows(crowded.log, path)} with another user`);
      // A small allowance: the owner check walks the albums table, which grows with every album.
      expect(rows(crowded.log, path), topic).toBeLessThan(rows(alone.log, path) * 1.1 + 200);
    }
    const day = `/insights/on-this-day?date=${indiaDate(new Date())}`;
    console.log(`on-this-day: ${rows(alone.log, day)} rows alone, ${rows(crowded.log, day)} with another user`);
    expect(rows(crowded.log, day), 'on-this-day').toBeLessThan(rows(alone.log, day) + 20);
  });
});
