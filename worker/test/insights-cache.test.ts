import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { indiaDate, periodStart } from '../src/insights/common';
import { readHeaders } from './helpers';
import { clearInsights, getJson, seedMany, seedPhoto } from './insights-helpers';

const today = indiaDate(new Date());
const row = (topic: string) =>
  env.DB.prepare('SELECT day, data FROM insights_cache WHERE topic = ?').bind(topic).first<{ day: string; data: string }>();
const facts = async (topic: string) => (await getJson(`/insights/${topic}`)).body.facts;
const plant = (topic: string, day: string) => env.DB.prepare('UPDATE insights_cache SET day = ? WHERE topic = ?').bind(day, topic).run();
const dated = () => ({ dt: '2025-06-04T06:00:00.000Z' });

describe('refresh cycle', () => {
  it('starts a new 30-day cycle on one day, shifted by the offset', () => {
    const start = periodStart('2026-11-28', 0);
    const day = (n: number) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    expect(periodStart(day(29), 0)).toBe(start);
    expect(periodStart(day(30), 0)).toBe(day(30));
    expect(periodStart(day(-1), 0)).toBe(day(-30));
    expect(periodStart(day(5), 5)).toBe(day(5));
    expect(periodStart(day(4), 5)).toBe(day(-25));
  });
});

describe('cached tile topics', () => {
  beforeEach(clearInsights);

  it('keeps facts until the next cycle starts', async () => {
    await seedMany(100, dated);
    expect((await facts('time'))[0].data.total).toBe(100);
    expect((await row('time'))!.day).toBe(periodStart(today, 0));
    await seedPhoto(dated());
    expect((await facts('time'))[0].data.total).toBe(100);
    await plant('time', '2000-01-01');
    expect((await facts('time'))[0].data.total).toBe(101);
  });

  it('keeps an empty answer for one day only', async () => {
    await seedMany(5, dated);
    expect(await facts('time')).toEqual([]);
    expect((await row('time'))!.day).toBe(`empty:${today}`);
    await seedMany(95, dated);
    expect(await facts('time')).toEqual([]);
    await plant('time', 'empty:2000-01-01');
    expect((await facts('time')).length).toBeGreaterThan(0);
  });

  it('caches the gear recipe apart from the other gear facts, on another day', async () => {
    // 60 weak photos and 50 strong ones in one group, so that there is a recipe; two lenses for the rest.
    await seedMany(60, () => ({ dt: '2025-06-04T06:00:00.000Z', focal_length: 50, lens_model: 'A', score: 2 }));
    await seedMany(50, () => ({ dt: '2025-06-01T01:00:00.000Z', focal_length: 500, lens_model: 'B', score: 9 }));
    const first = await facts('gear');
    expect(first.map((f: any) => f.id)).toEqual(['top-lens', 'hit-rate', 'recipe']);
    expect((await row('gear'))!.day).toBe(periodStart(today, 5));
    expect((await row('gear-recipe'))!.day).toBe(periodStart(today, 25));
    await env.DB.prepare(`DELETE FROM insights_cache WHERE topic = 'gear-recipe'`).run();
    await env.DB.prepare('DELETE FROM photos').run();
    // Only the recipe is calculated again: the other gear facts come from the cache.
    expect((await facts('gear')).map((f: any) => f.id)).toEqual(['top-lens', 'hit-rate']);
    expect((await row('gear-recipe'))!.day).toBe(`empty:${today}`);
  });

  it('has no gear-recipe route', async () => {
    expect((await getJson('/insights/gear-recipe')).status).toBe(404);
  });
});

describe('POST /insights/refresh', () => {
  beforeEach(clearInsights);

  const refresh = async (email?: string) => {
    const r = await SELF.fetch('https://example.com/insights/refresh', {
      method: 'POST',
      headers: { ...readHeaders(email), 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { status: r.status, body: r.status === 200 ? ((await r.json()) as { removed: number }) : null };
  };
  const age = (minutes: number) =>
    env.DB.prepare('UPDATE insights_cache SET computed_at = ?').bind(new Date(Date.now() - minutes * 60_000).toISOString()).run();

  it('removes the cached parts, so that the next visit calculates them again', async () => {
    await seedMany(100, dated);
    expect((await facts('time'))[0].data.total).toBe(100);
    await seedPhoto(dated());
    await age(6);
    expect(await refresh()).toEqual({ status: 200, body: { removed: 1 } });
    expect((await facts('time'))[0].data.total).toBe(101);
  });

  it('keeps a part that was calculated less than 5 minutes ago', async () => {
    await seedMany(100, dated);
    await facts('time');
    await age(4);
    expect((await refresh()).body).toEqual({ removed: 0 });
    expect(await row('time')).not.toBeNull();
  });

  it("removes only the caller's rows", async () => {
    await seedMany(100, dated);
    await facts('time');
    await getJson('/insights/time', 'friend@example.com');
    await age(6);
    expect((await refresh('friend@example.com')).body).toEqual({ removed: 1 });
    const left = await env.DB.prepare('SELECT email FROM insights_cache').all<{ email: string }>();
    expect(left.results).toEqual([{ email: 'owner@example.com' }]);
  });

  it('needs the read token and a viewer', async () => {
    const r = await SELF.fetch('https://example.com/insights/refresh', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });
});
