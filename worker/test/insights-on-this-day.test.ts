import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { indiaDate } from '../src/insights/common';
import { blockStart, onThisDayBlock, onThisDayIds, onThisDayRanges } from '../src/insights/onThisDay';
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

describe('seven-day block', () => {
  beforeEach(clearInsights);

  it('starts on the same day for seven dates in a row', () => {
    const start = blockStart('2026-11-28');
    expect(blockStart(start)).toBe(start);
    expect(blockStart(shift(start, 6))).toBe(start);
    expect(blockStart(shift(start, 7))).toBe(shift(start, 7));
    expect(blockStart(shift(start, -1))).toBe(shift(start, -7));
  });

  // Worker CPU: a date text costs much more than a day number. Build only the texts that the query binds.
  it.each(['2026-11-28', '2026-12-31'])('builds few date texts for the block of %s', async (date) => {
    await seedPhoto({ dt: '2025-11-28T06:30:00.000Z' });
    const spy = vi.spyOn(Date.prototype, 'toISOString');
    try {
      await onThisDayBlock(env.DB, 'owner@example.com', blockStart(date));
      // At most two calendar years, 37 earlier years each, two bounds each, and the seven dates.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(160);
    } finally {
      spy.mockRestore();
    }
  });

  // Blocks that cross New Year and hold the leap day of a leap year and of another year.
  it.each(['2026-12-31', '2028-02-29', '2027-02-28', '2026-11-28'])('gives each date of the block of %s its own 12 best photos', async (date) => {
    const start = blockStart(date);
    const dates = Array.from({ length: 7 }, (_, i) => shift(start, i));
    // Two earlier years, every day from five days before the block to five days after it, with mixed scores.
    let n = 0;
    for (const back of [1, 4]) {
      for (let d = -5; d < 12; d++) {
        const [, m, day] = shift(start, d).split('-');
        const year = Number(shift(start, d).slice(0, 4)) - back;
        for (let i = 0; i < 4; i++, n++) {
          const dt = new Date(Date.UTC(year, Number(m) - 1, Number(day), 1 + i * 5)).toISOString();
          await seedPhoto({ id: `b${String(n).padStart(4, '0')}`, dt, score: n % 7 === 0 ? null : (n * 13) % 10 });
        }
      }
    }
    const all = (await env.DB.prepare('SELECT id, date_time AS dt, aesthetic_score AS score FROM photos').all<{ id: string; dt: string; score: number | null }>()).results;
    const best = (a: (typeof all)[number], b: (typeof all)[number]) =>
      (b.score ?? -1) - (a.score ?? -1) || (a.dt < b.dt ? 1 : a.dt > b.dt ? -1 : 0) || (a.id < b.id ? -1 : 1);
    const block = await onThisDayBlock(env.DB, 'owner@example.com', start);
    expect(Object.keys(block)).toEqual(dates);
    for (const d of dates) {
      const expected = onThisDayRanges(d)
        .reverse()
        .map(({ year, from, to }) => ({ year, ids: all.filter((p) => p.dt >= from && p.dt < to).sort(best).slice(0, 12).map((p) => p.id) }))
        .filter((y) => y.ids.length > 0);
      expect(expected.length, d).toBeGreaterThan(0);
      expect(block[d], d).toEqual(expected);
    }
  }, 60_000);
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

  it('calculates once for each seven-day block and version', async () => {
    const first = await seedPhoto({ dt: ago(1) });
    expect(ids((await get()).body)).toEqual([first]);
    const second = await seedPhoto({ dt: ago(1), score: 9 });
    expect(ids((await get()).body)).toEqual([first]);
    await env.DB.prepare('UPDATE insights_cache SET version = 0').run();
    expect(ids((await get()).body)).toEqual([second, first]);
    const third = await seedPhoto({ dt: ago(1), score: 10 });
    await env.DB.prepare(`UPDATE insights_cache SET day = '2000-01-06'`).run();
    expect(ids((await get()).body)).toEqual([third, second, first]);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(day) AS day FROM insights_cache').first<{ n: number; day: string }>();
    expect(row).toEqual({ n: 1, day: blockStart(today) });
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
