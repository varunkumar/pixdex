import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { gearFacts } from '../src/insights/gear';
import { clearInsights, getJson, seedMany, seedPhoto } from './insights-helpers';

const TODAY = '2026-11-28';
const run = () => gearFacts(env.DB, 'owner@example.com', TODAY);
const fact = async (id: string) => (await run()).find((f) => f.id === id)?.data as any;
/** 06:00 UTC is 11:30 in camera time. */
const at = (day: string, time = '06:00:00') => `${day}T${time}.000Z`;
const lens = (count: number, name: string, score: number | null, extra: Record<string, unknown> = {}) =>
  seedMany(count, () => ({ score, lens_model: name, ...extra }));

describe('gear facts', () => {
  beforeEach(clearInsights);

  it('names the lens with the most hits from 20 hits', async () => {
    await lens(19, 'Long', 8);
    await lens(5, 'Long', 7.9);
    expect(await fact('top-lens')).toBeUndefined();
    await lens(1, 'Long', 8);
    await lens(3, 'Short', 9);
    expect(await fact('top-lens')).toEqual({ lens: 'Long', hits: 20, photos: 25, knownLensPhotos: 28 });
  });

  it('counts the owner stars in a hit', async () => {
    await lens(19, 'Long', 9);
    await lens(1, 'Long', 6, { user_rating: 5 }); // 0.7 * 10 + 0.3 * 6 = 8.8
    expect((await fact('top-lens')).hits).toBe(20);
  });

  it('compares the hit rate of lenses with 50 photos', async () => {
    await lens(50, 'A', 9);
    await lens(49, 'B', 9);
    expect(await fact('hit-rate')).toBeUndefined();
    await lens(1, 'B', 2);
    for (const name of ['C', 'D', 'E']) {
      await lens(10, name, 9);
      await lens(40, name, 2);
    }
    const data = await fact('hit-rate');
    expect(data.lenses).toHaveLength(4);
    expect(data.lenses.slice(0, 2)).toEqual([
      { lens: 'A', hits: 50, photos: 50 },
      { lens: 'B', hits: 49, photos: 50 },
    ]);
  });

  it('finds the best weekday, slot and focal group of 50 photos', async () => {
    const good = { dt: at('2025-06-01', '01:00:00'), focal_length: 500, score: 9 }; // Sunday 06:30 camera time
    await seedMany(49, () => good);
    await seedMany(60, () => ({ dt: at('2025-06-04'), focal_length: 50, score: 2 }));
    expect(await fact('recipe')).toBeUndefined();
    await seedPhoto(good);
    expect(await fact('recipe')).toEqual({ weekday: 0, slot: 6, focal: '400-plus', hits: 50, photos: 50, allHits: 50, allPhotos: 110 });
  });

  it('has no recipe when no group beats the average', async () => {
    await seedMany(60, () => ({ dt: at('2025-06-04'), focal_length: 50, score: 9 }));
    expect(await fact('recipe')).toBeUndefined();
  });

  it('shows how far the most used zoom lens is zoomed', async () => {
    await lens(30, 'Zoom', null, { focal_length: 150 });
    await lens(7, 'Zoom', null, { focal_length: 400 });
    await lens(62, 'Zoom', null, { focal_length: 600 });
    await lens(200, 'Prime', null, { focal_length: 50 });
    expect(await fact('zoom')).toBeUndefined();
    await lens(1, 'Zoom', null, { focal_length: 570 });
    const data = await fact('zoom');
    expect(data).toMatchObject({ lens: 'Zoom', min: 150, max: 600, atMax: 63, photos: 100 });
    expect(data.buckets).toEqual([
      { from: 150, to: 240, photos: 30 },
      { from: 240, to: 330, photos: 0 },
      { from: 330, to: 420, photos: 7 },
      { from: 420, to: 510, photos: 0 },
      { from: 510, to: 600, photos: 63 },
    ]);
  });

  it('counts moments: a gap over 2 seconds, or another camera, starts a new one', async () => {
    // 2024: 33 moments of three frames (0 s, 2 s, 5 s is 2 moments), plus a second camera at the same second.
    const sec = (s: number) => String(s).padStart(2, '0');
    for (let i = 0; i < 33; i++) {
      for (const s of [0, 2, 5]) await seedPhoto({ camera_model: 'One', dt: at('2024-02-01', `06:${sec(i)}:${sec(s)}`) });
    }
    await seedPhoto({ camera_model: 'Two', dt: at('2024-02-01', '06:00:00') });
    expect(await fact('burst')).toBeUndefined();
    await seedMany(100, () => ({ camera_model: 'One', dt: at('2025-02-01') }));
    expect(await fact('burst')).toEqual({
      years: [
        { year: 2024, photos: 100, moments: 67 },
        { year: 2025, photos: 100, moments: 1 },
      ],
    });
  });

  it('tracks the hit rate by year with the main camera', async () => {
    await seedMany(90, () => ({ camera_model: 'Old', dt: at('2024-02-01'), score: 2 }));
    await seedMany(10, () => ({ dt: at('2024-02-02'), score: 9 }));
    expect(await fact('progress')).toBeUndefined();
    await seedMany(100, () => ({ dt: at('2025-02-01'), score: 9 }));
    expect(await fact('progress')).toEqual({
      years: [
        { year: 2024, photos: 100, hits: 10, camera: 'Old' },
        { year: 2025, photos: 100, hits: 100, camera: null },
      ],
    });
  });

  it('lists the eras of the 6 most used cameras with 20 photos', async () => {
    await seedMany(20, () => ({ camera_model: 'C1', dt: at('2015-01-01') }));
    await seedMany(19, () => ({ camera_model: 'C2', dt: at('2016-01-01') }));
    expect(await fact('cameras')).toBeUndefined();
    await seedPhoto({ camera_model: 'C2', dt: at('2018-05-05') });
    for (let c = 3; c <= 8; c++) await seedMany(20 + c, () => ({ camera_model: `C${c}`, dt: at(`20${c + 15}-01-01`) }));
    await seedPhoto({ camera_model: 'Rare', dt: at('2010-01-01') });
    const data = await fact('cameras');
    expect(data.total).toBe(9);
    expect(data.cameras.map((c: any) => c.camera)).toEqual(['C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
    expect(data.cameras[0]).toEqual({ camera: 'C3', first: '2018-01-01', last: '2018-01-01', photos: 23 });
  });

  it('answers with no hit facts when nothing has a score', async () => {
    await seedMany(120, () => ({ lens_model: 'A', focal_length: 50, camera_model: 'One', dt: at('2025-02-01') }));
    const { status, body } = await getJson('/insights/gear');
    expect(status).toBe(200);
    expect(body.facts.map((f: any) => f.id)).toEqual([]);
  });
});
