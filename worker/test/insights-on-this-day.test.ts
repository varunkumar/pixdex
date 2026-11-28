import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { indiaDate } from '../src/insights/common';
import { onThisDayIds, onThisDayRanges } from '../src/insights/onThisDay';
import { clearInsights, getJson, seedPhoto } from './insights-helpers';

const today = indiaDate(new Date());
const Y = Number(today.slice(0, 4));
const MD = today.slice(4) === '-02-29' ? '-02-28' : today.slice(4);
/** Today's month and day, `back` years ago. 06:30 UTC is noon in camera time. */
const ago = (back: number) => `${Y - back}${MD}T06:30:00.000Z`;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const get = (date = today) => getJson(`/insights/on-this-day?date=${date}`);
const ids = (body: any): string[] => body.years.flatMap((y: any) => y.photos.map((p: any) => p.id));

describe('on this day windows', () => {
  it('builds one window for each earlier year, in camera time', () => {
    const r = onThisDayRanges('2026-11-28').find((x) => x.year === 2025)!;
    expect(r).toEqual({ year: 2025, from: '2025-11-25T18:30:00', to: '2025-11-30T18:30:00' });
    expect(onThisDayRanges('2026-11-28').map((x) => x.year)).not.toContain(2026);
  });

  it('crosses New Year and treats 29 February as 28 February', () => {
    expect(onThisDayRanges('2027-01-01').find((x) => x.year === 2026)!.from).toBe('2025-12-29T18:30:00');
    expect(onThisDayRanges('2028-02-29').find((x) => x.year === 2027)!.to).toBe('2027-03-02T18:30:00');
  });

  it('gives the India date of an instant', () => {
    expect(indiaDate(new Date('2026-11-27T18:29:59Z'))).toBe('2026-11-27');
    expect(indiaDate(new Date('2026-11-27T18:30:00Z'))).toBe('2026-11-28');
  });
});

describe('GET /insights/on-this-day', () => {
  beforeEach(clearInsights);

  it('reads the window in camera time', async () => {
    const inside = await seedPhoto({ dt: '2025-11-25T23:30:00.000Z' }); // 05:00 on 26 November
    await seedPhoto({ dt: '2025-11-25T18:00:00.000Z' }); // 23:30 on 25 November
    expect(await onThisDayIds(env.DB, 'owner@example.com', '2026-11-28')).toEqual([{ year: 2025, ids: [inside] }]);
  });

  it('lists years newest first with the 12 best photos of each', async () => {
    for (let i = 0; i < 15; i++) await seedPhoto({ id: `best${i}`, dt: ago(1), score: i / 2 });
    const older = await seedPhoto({ dt: ago(3), score: 1 });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.date).toBe(today);
    expect(body.years.map((y: any) => y.year)).toEqual([Y - 1, Y - 3]);
    expect(body.years[0].photos.map((p: any) => p.id)).toEqual(Array.from({ length: 12 }, (_, i) => `best${14 - i}`));
    expect(body.years[1].photos[0]).toMatchObject({ id: older, canEdit: true });
  });

  it('skips junk dates and the current year', async () => {
    await seedPhoto({ dt: `1899${MD}T06:30:00.000Z` });
    await seedPhoto({ dt: `${Y - 1}:${MD.slice(1, 3)}:${MD.slice(4)}` });
    await seedPhoto({ dt: null });
    await seedPhoto({ dt: ago(0) });
    expect((await get()).body.years).toEqual([]);
  });

  it('does not count an album that another user shares with the viewer', async () => {
    await seedPhoto({ dt: ago(1), album: 'Theirs' });
    await env.DB.prepare(`UPDATE albums SET owner_email = 'other@example.com', shared_with = '["owner@example.com"]' WHERE name = 'Theirs'`).run();
    expect((await get()).body.years).toEqual([]);
  });

  it('rejects a date far from today and a bad date', async () => {
    expect((await get(shift(today, 3))).status).toBe(400);
    expect((await get(shift(today, -3))).status).toBe(400);
    expect((await get('2026-13-40')).status).toBe(400);
    expect((await get('today')).status).toBe(400);
    expect((await getJson('/insights/on-this-day')).status).toBe(400);
    expect((await get(shift(today, 2))).status).toBe(200);
  });

  it('calculates once for each date and version', async () => {
    const first = await seedPhoto({ dt: ago(1) });
    expect(ids((await get()).body)).toEqual([first]);
    const second = await seedPhoto({ dt: ago(1), score: 9 });
    expect(ids((await get()).body)).toEqual([first]);
    await env.DB.prepare('UPDATE insights_cache SET version = 0').run();
    expect(ids((await get()).body)).toEqual([second, first]);
    const third = await seedPhoto({ dt: ago(1), score: 10 });
    expect(ids((await get(shift(today, 1))).body)).toContain(third);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM insights_cache').first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it('drops a cached photo that is deleted or no longer owned', async () => {
    const gone = await seedPhoto({ dt: ago(1) });
    const moved = await seedPhoto({ dt: ago(2), album: 'B' });
    const kept = await seedPhoto({ dt: ago(3) });
    expect(ids((await get()).body).sort()).toEqual([gone, moved, kept].sort());
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(gone).run();
    await env.DB.prepare(`UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'B'`).run();
    const { body } = await get();
    expect(body.years.map((y: any) => y.year)).toEqual([Y - 3]);
    expect(ids(body)).toEqual([kept]);
  });

  it('gives 404 for an unknown topic', async () => {
    expect((await getJson('/insights/nope')).status).toBe(404);
  });
});
