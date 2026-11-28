import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { wildlifeFacts } from '../src/insights/wildlife';
import { clearInsights, getJson, seedMany, seedPhoto } from './insights-helpers';

const TODAY = '2026-11-28';
const run = () => wildlifeFacts(env.DB, 'owner@example.com', TODAY);
const fact = async (id: string) => (await run()).find((f) => f.id === id)?.data as any;
const of = (...names: string[]) => JSON.stringify(names.map((common) => ({ common, scientific: `${common} sp.`, score: 0.9 })));
const at = (day: string, time = '06:00:00') => `${day}T${time}.000Z`;

describe('wildlife facts', () => {
  beforeEach(clearInsights);

  it('needs 5 species for the life list', async () => {
    for (const name of ['A', 'B', 'C', 'D']) await seedPhoto({ species: of(name), dt: at('2025-01-01') });
    expect(await fact('life-list')).toBeUndefined();
    await seedPhoto({ species: of('E'), dt: at('2024-01-01') });
    expect(await fact('life-list')).toEqual({
      total: 5,
      year: 2025,
      newInYear: 4,
      once: 5,
      byYear: [
        { year: 2024, total: 1 },
        { year: 2025, total: 5 },
      ],
    });
  });

  it('uses the current year when it has a new species, and counts species seen in one photo', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await seedPhoto({ species: of(name), dt: at('2025-01-01') });
    await seedPhoto({ species: of('A', 'A'), dt: at('2025-02-01') }); // twice in one photo counts once
    await seedPhoto({ species: of('F'), dt: at('2026-02-01') });
    await seedPhoto({ species: of('G'), dt: null }); // counted, but has no first year
    expect(await fact('life-list')).toMatchObject({ total: 7, year: 2026, newInYear: 1, once: 6 });
  });

  it('finds the month and slot of the most photographed species from 30 photos', async () => {
    await seedMany(20, () => ({ species: of('Tiger'), dt: at('2025-03-05', '01:00:00') })); // 06:30
    await seedMany(9, () => ({ species: of('Tiger', 'Deer'), dt: at('2025-05-05', '10:00:00') })); // 15:30
    expect(await fact('best-chance')).toBeUndefined();
    await seedPhoto({ species: of('Tiger', 'Tiger'), dt: at('2024-03-05', '05:00:00') }); // 10:30
    expect(await fact('best-chance')).toEqual({
      species: 'Tiger',
      photos: 30,
      month: 3,
      slot: 6,
      slots: [
        { slot: 6, photos: 20 },
        { slot: 10, photos: 1 },
      ],
    });
  });

  it('skips bad species text and photos of other owners', async () => {
    for (const species of ['not json', '"text"', '[1, "two"]', '{"common":"X"}']) await seedPhoto({ species });
    await seedPhoto({ species: of('A'), album: 'Theirs' });
    await env.DB.prepare(`UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Theirs'`).run();
    const { status, body } = await getJson('/insights/wildlife');
    expect(status).toBe(200);
    expect(body.facts).toEqual([]);
  });
});
