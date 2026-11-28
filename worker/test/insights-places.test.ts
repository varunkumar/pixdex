import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { placesFacts } from '../src/insights/places';
import { clearInsights, seedMany, seedPhoto } from './insights-helpers';

const TODAY = '2026-11-28';
const run = () => placesFacts(env.DB, 'owner@example.com', TODAY);
const fact = async (id: string) => (await run()).find((f) => f.id === id)?.data as any;
const at = (day: string) => `${day}T06:00:00.000Z`;
const day = (i: number) => `2025-01-${String(i).padStart(2, '0')}`;
const BENGALURU = { latitude: 12.97, longitude: 77.59 };
const MYSURU = { latitude: 12.3, longitude: 76.64 };

describe('places facts', () => {
  beforeEach(clearInsights);

  it('measures the farthest photo from the cell with the most days, from 100 GPS photos', async () => {
    for (let i = 1; i <= 5; i++) await seedPhoto({ ...BENGALURU, dt: at(day(i)), place: 'Bengaluru, IN' });
    // Many more photos on fewer days: not the usual spot.
    await seedMany(94, () => ({ ...MYSURU, dt: at('2025-03-01'), place: 'Mysuru, IN' }));
    expect(await fact('travel')).toBeUndefined();
    await seedPhoto({ ...MYSURU, dt: at('2025-04-02'), place: 'Mysuru, IN' });
    const travel = await fact('travel');
    expect(travel.km).toBeGreaterThanOrEqual(120);
    expect(travel.km).toBeLessThanOrEqual(140);
    expect(travel).toMatchObject({ place: 'Mysuru, IN', date: '2025-04-02', gpsPhotos: 100 });
  });

  it('skips GPS 0,0 and gives no place name when there is none', async () => {
    for (let i = 1; i <= 5; i++) await seedPhoto({ ...BENGALURU, dt: at(day(i)) });
    await seedMany(95, () => ({ ...MYSURU, dt: at('2025-03-01'), place: '' }));
    await seedPhoto({ latitude: 0, longitude: 0, dt: at('2025-05-01') });
    expect(await fact('travel')).toMatchObject({ place: null, gpsPhotos: 100, date: '2025-03-01' });
    expect(await fact('places')).toBeUndefined();
  });

  it('lists the top places by days and the places new this year or last, from 20 photos with a place', async () => {
    await seedMany(10, () => ({ ...MYSURU, dt: at('2024-02-01'), place: 'Mysuru, IN' }));
    await seedMany(5, (i) => ({ ...BENGALURU, dt: at(day(i + 1)), place: 'Bengaluru, IN' }));
    await seedMany(4, () => ({ ...MYSURU, dt: at('2025-02-02'), place: 'Ooty, IN' }));
    await seedMany(3, () => ({ ...MYSURU, dt: at('2025-02-03'), place: '' }));
    expect(await fact('places')).toBeUndefined();
    await seedPhoto({ ...MYSURU, dt: at('2025-02-04'), place: 'Ooty, IN' });
    expect(await fact('places')).toEqual({
      year: 2025,
      newCount: 2,
      top: [
        { place: 'Bengaluru, IN', days: 5, photos: 5 },
        { place: 'Ooty, IN', days: 2, photos: 5 },
        { place: 'Mysuru, IN', days: 1, photos: 10 },
      ],
      gpsPhotos: 23, // the 3 photos with no town near still have GPS
    });
    await seedPhoto({ ...MYSURU, dt: at('2026-02-04'), place: 'Salem, IN' });
    expect(await fact('places')).toMatchObject({ year: 2026, newCount: 1 });
  });

  it('ignores photos without a believable date', async () => {
    await seedMany(100, () => ({ ...MYSURU, dt: '1899-11-29T18:38:50.000Z', place: 'Mysuru, IN' }));
    expect(await run()).toEqual([]);
  });
});
