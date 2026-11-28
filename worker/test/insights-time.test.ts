import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { timeFacts } from '../src/insights/time';
import { clearInsights, getJson, seedMany, seedPhoto } from './insights-helpers';

const TODAY = '2026-11-28';
const run = () => timeFacts(env.DB, 'owner@example.com', TODAY);
const fact = async (id: string) => (await run()).find((f) => f.id === id)?.data as any;
const pad = (n: number) => String(n).padStart(2, '0');
/** 06:00 UTC is 11:30 in camera time. */
const at = (day: string) => `${day}T06:00:00.000Z`;

describe('time facts', () => {
  beforeEach(clearInsights);

  it('needs 100 dated photos for the top month and weekday', async () => {
    await seedMany(99, () => ({ dt: at('2025-06-04') }));
    expect(await fact('top-month')).toBeUndefined();
    expect(await fact('top-weekday')).toBeUndefined();
    await seedPhoto({ dt: at('2025-07-02') });
    const month = await fact('top-month');
    expect(month.total).toBe(100);
    expect(month.counts).toHaveLength(12);
    expect([month.counts[5], month.counts[6]]).toEqual([99, 1]);
    const weekday = await fact('top-weekday');
    expect(weekday.counts).toHaveLength(7);
    expect(weekday.counts[3]).toBe(100); // both dates are Wednesdays
  });

  it('counts in camera time and skips junk dates', async () => {
    await seedMany(100, () => ({ dt: '2025-03-29T23:30:00.000Z' })); // 05:00 on Sunday 30 March
    for (const dt of ['1899-11-29T18:38:50.000Z', '2027-03-01T06:00:00.000Z', '2025:03:30 05:00:00', null]) await seedPhoto({ dt });
    expect((await fact('top-weekday')).counts[0]).toBe(100);
    expect((await fact('top-month')).total).toBe(100);
  });

  it('reports the busiest day and the longest break from 10 shooting days', async () => {
    for (let d = 1; d <= 9; d++) await seedPhoto({ dt: at(`2025-01-${pad(d)}`) });
    expect(await fact('records')).toBeUndefined();
    await seedMany(3, () => ({ dt: at('2025-03-01') }));
    expect(await fact('records')).toEqual({
      busiest: { date: '2025-03-01', count: 3 },
      gap: { days: 51, from: '2025-01-09', to: '2025-03-01' },
    });
  });

  it('reports a moved peak month between the older and newer years', async () => {
    for (const year of [2020, 2021]) await seedMany(100, () => ({ dt: at(`${year}-12-05`) }));
    for (const year of [2022, 2023]) await seedMany(100, () => ({ dt: at(`${year}-03-05`) }));
    expect(await fact('shifts')).toEqual({ older: { from: 2020, to: 2021, month: 12 }, newer: { from: 2022, to: 2023, month: 3 } });
  });

  it('gives the extra year to the newer half', async () => {
    for (const year of [2019, 2020]) await seedMany(100, () => ({ dt: at(`${year}-12-05`) }));
    for (const year of [2021, 2022, 2023]) await seedMany(100, () => ({ dt: at(`${year}-03-05`) }));
    expect(await fact('shifts')).toMatchObject({ older: { from: 2019, to: 2020 }, newer: { from: 2021, to: 2023 } });
  });

  it('has no shift fact with equal months, under 4 years or in one year', async () => {
    for (const year of [2020, 2021, 2022]) await seedMany(100, () => ({ dt: at(`${year}-03-05`) }));
    expect(await fact('shifts')).toBeUndefined();
    await seedMany(100, () => ({ dt: at('2023-03-05') }));
    expect(await fact('shifts')).toBeUndefined();
  });

  it('answers a user with no albums with no facts', async () => {
    const { status, body } = await getJson('/insights/time', 'nobody@example.com');
    expect(status).toBe(200);
    expect(body.facts).toEqual([]);
  });
});
