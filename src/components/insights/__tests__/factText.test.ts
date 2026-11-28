import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Fact } from '../../../types/api';
import { describeFact } from '../factText';

const months = (peak: number) => Array.from({ length: 12 }, (_, i) => (i === peak ? 30 : 5));

const CASES: [Fact, { topic: string; label: string; value: string; headline: string; note: string }][] = [
  [
    { id: 'top-month', data: { counts: months(5), total: 1085 } },
    { topic: 'time', label: 'Top month', value: 'June', headline: 'June is your busiest month', note: '30 of 1,085 dated photos' },
  ],
  [
    { id: 'top-weekday', data: { counts: [10, 10, 10, 40, 10, 10, 10], total: 100 } },
    { topic: 'time', label: 'Top weekday', value: 'Wed', headline: 'Wednesday is your top day', note: '40% of dated photos' },
  ],
  [
    { id: 'records', data: { busiest: { date: '2016-03-12', count: 312 }, gap: { days: 74, from: '2019-01-01', to: '2019-03-16' } } },
    { topic: 'time', label: 'Records', value: '312', headline: '312 photos in one day', note: '12 Mar 2016. Longest break: 74 days, in your indexed photos.' },
  ],
  [
    { id: 'shifts', data: { older: { from: 2012, to: 2018, month: 12 }, newer: { from: 2019, to: 2026, month: 3 } } },
    { topic: 'time', label: 'Peak month moved', value: 'Dec→Mar', headline: 'Your peak month moved from December to March', note: '2012-2018 against 2019-2026' },
  ],
  [
    { id: 'top-lens', data: { lens: '150-600mm', hits: 41, photos: 160, knownLensPhotos: 400 } },
    { topic: 'gear', label: 'Best-rated lens', value: '150-600mm', headline: 'Most of your best photos use 150-600mm', note: '41 high-scoring photos. Only photos with a known lens.' },
  ],
  [
    { id: 'hit-rate', data: { lenses: [{ lens: 'A', hits: 24, photos: 100 }, { lens: 'B', hits: 8, photos: 100 }] } },
    { topic: 'gear', label: 'Hit rate by lens', value: '24%', headline: 'A wins most often', note: 'Share that scores 7+, for photos with a known lens' },
  ],
  [
    { id: 'recipe', data: { weekday: 0, slot: 6, focal: '400-plus', hits: 31, photos: 100, allHits: 13, allPhotos: 100 } },
    { topic: 'gear', label: 'Winning recipe', value: 'Sun 06:00', headline: 'Sunday, 06:00 to 08:00, 400 mm or more', note: '31% score 7+, against 13% for all photos' },
  ],
  [
    { id: 'zoom', data: { lens: 'Zoom', min: 150, max: 600, atMax: 62, photos: 100, buckets: [{ from: 150, to: 600, photos: 100 }] } },
    { topic: 'gear', label: 'Real zoom use', value: '62%', headline: '62% of shots at the long end', note: 'Zoom, 150 to 600 mm' },
  ],
  [
    { id: 'burst', data: { years: [{ year: 2015, photos: 200, moments: 100 }, { year: 2026, photos: 650, moments: 100 }] } },
    { topic: 'gear', label: 'Burst habit', value: '6.5', headline: '6.5 frames for each moment', note: 'It was 2 in 2015' },
  ],
  [
    { id: 'progress', data: { years: [{ year: 2021, photos: 100, hits: 9, camera: 'Old' }, { year: 2025, photos: 200, hits: 42, camera: 'New' }] } },
    { topic: 'gear', label: 'Hit rate by year', value: '9%→21%', headline: 'Your 7+ share went from 9% to 21%', note: 'Main camera: Old in 2021, New in 2025' },
  ],
  [
    { id: 'cameras', data: { total: 38, cameras: [{ camera: 'One', first: '2005-01-01', last: '2010-01-01', photos: 30 }, { camera: 'Two', first: '2010-01-01', last: '2025-01-01', photos: 40 }] } },
    { topic: 'gear', label: 'Camera eras', value: '38', headline: '38 cameras', note: 'First to last use, top 2 shown' },
  ],
  [
    { id: 'life-list', data: { total: 84, year: 2025, newInYear: 12, once: 19, byYear: [{ year: 2024, total: 72 }, { year: 2025, total: 84 }] } },
    { topic: 'wildlife', label: 'Life list', value: '84', headline: '84 species, 12 new in 2025', note: '19 species seen only once' },
  ],
  [
    { id: 'best-chance', data: { species: 'Tiger', photos: 41, month: 3, slot: 6, slots: [{ slot: 6, photos: 20 }] } },
    { topic: 'wildlife', label: 'Best chance', value: 'Mar', headline: 'Tiger: March, 06:00 to 08:00', note: 'From 41 photos of this species' },
  ],
  [
    { id: 'together', data: { pairs: [{ a: { id: 'a', name: 'Asha' }, b: { id: 'b', name: 'Ravi' }, photos: 418 }] } },
    { topic: 'people', label: 'Together', value: '418', headline: 'Asha and Ravi appear together most', note: 'Photos with both people' },
  ],
  [
    { id: 'missed', data: { person: { id: 'm', name: 'Meera' }, lastDate: '2024-08-02', photos: 40 } },
    { topic: 'people', label: 'Missed', value: '2 yr', headline: 'No photo of Meera for 2 years', note: 'Last seen August 2024, in your indexed photos' },
  ],
  [
    { id: 'travel', data: { km: 13400, place: 'Newark, US', date: '2019-05-02', gpsPhotos: 1684 } },
    { topic: 'places', label: 'Travel', value: '13,400 km', headline: 'Your farthest photo: 13,400 km', note: 'Near Newark, US, 2 May 2019. From your usual spot. Only photos with GPS.' },
  ],
  [
    { id: 'places', data: { year: 2026, newCount: 3, top: [{ place: 'Mysuru, IN', days: 31, photos: 200 }], gpsPhotos: 1684 } },
    { topic: 'places', label: 'Places', value: '3 new', headline: '3 new places in 2026', note: 'Days with photos. Only photos with GPS.' },
  ],
];

describe('describeFact', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-28T00:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it.each(CASES)('writes $0.id', (fact, text) => {
    expect(describeFact(fact)).toMatchObject(text);
  });

  it('names only the years that have a camera, and none when neither has one', () => {
    const progress = (first: string | null, last: string | null): Fact => ({
      id: 'progress',
      data: { years: [{ year: 2021, photos: 100, hits: 9, camera: first }, { year: 2025, photos: 100, hits: 9, camera: last }] },
    });
    expect(describeFact(progress('Old', null)).note).toBe('Main camera: Old in 2021');
    expect(describeFact(progress(null, null)).note).toBe('');
  });

  it('highlights the top column and places camera spans on one scale', () => {
    expect(describeFact(CASES[0][0]).chart).toMatchObject({ type: 'columns', highlight: 5 });
    const chart = describeFact(CASES[10][0]).chart as { type: string; rows: { start: number; width: number }[] };
    expect(chart.rows[0].start).toBe(0);
    expect(chart.rows[1].start + chart.rows[1].width).toBeCloseTo(100);
    expect(chart.rows[0].width).toBeCloseTo(25, 0);
  });
});
