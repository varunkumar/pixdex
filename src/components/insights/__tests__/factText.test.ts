import { describe, expect, it } from 'vitest';
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
    { topic: 'gear', label: 'Hit rate by lens', value: '24%', headline: 'A wins most often', note: 'Share that scores 8+, for photos with a known lens' },
  ],
  [
    { id: 'recipe', data: { weekday: 0, slot: 6, focal: '400-plus', hits: 31, photos: 100, allHits: 13, allPhotos: 100 } },
    { topic: 'gear', label: 'Winning recipe', value: 'Sun 06:00', headline: 'Sunday, 06:00 to 08:00, 400 mm or more', note: '31% score 8+, against 13% for all photos' },
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
    { topic: 'gear', label: 'Hit rate by year', value: '9%→21%', headline: 'Your 8+ share went from 9% to 21%', note: 'Main camera in 2025: New' },
  ],
  [
    { id: 'cameras', data: { total: 38, cameras: [{ camera: 'One', first: '2005-01-01', last: '2010-01-01', photos: 30 }, { camera: 'Two', first: '2010-01-01', last: '2025-01-01', photos: 40 }] } },
    { topic: 'gear', label: 'Camera eras', value: '38', headline: '38 cameras', note: 'First to last use, top 2 shown' },
  ],
];

describe('describeFact', () => {
  it.each(CASES)('writes $0.id', (fact, text) => {
    expect(describeFact(fact)).toMatchObject(text);
  });

  it('omits the camera sentence when the latest year has no camera', () => {
    const fact: Fact = { id: 'progress', data: { years: [{ year: 2021, photos: 100, hits: 9, camera: 'Old' }, { year: 2025, photos: 100, hits: 9, camera: null }] } };
    expect(describeFact(fact).note).toBe('');
  });

  it('highlights the top column and places camera spans on one scale', () => {
    expect(describeFact(CASES[0][0]).chart).toMatchObject({ type: 'columns', highlight: 5 });
    const chart = describeFact(CASES[10][0]).chart as { type: string; rows: { start: number; width: number }[] };
    expect(chart.rows[0].start).toBe(0);
    expect(chart.rows[1].start + chart.rows[1].width).toBeCloseTo(100);
    expect(chart.rows[0].width).toBeCloseTo(25, 0);
  });
});
