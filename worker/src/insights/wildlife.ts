import { CAMERA_OFFSET_MINUTES, datedCte, ownedSql } from './common';
import type { Fact, TopicBuilder } from './types';

const MIN_SPECIES = 5;
const MIN_BEST_CHANCE_PHOTOS = 30;
const YEARS_SHOWN = 5;

/** The stored species list as rows; text that is not JSON counts as no species. */
const ENTRIES = (column: string) => `json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END)`;
/** One entry's name; NULL for an entry that is not an object. */
const NAME = `CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.common') END`;

/**
 * One row for each species: the photos that show it and the first believable year (NULL when no photo of it has
 * one). Binds the owner email, then today.
 */
const SPECIES_SQL = `WITH o AS (
  SELECT id, species, datetime(date_time, '+${CAMERA_OFFSET_MINUTES} minutes') AS t FROM photos WHERE ${ownedSql('album')} AND species <> '[]'
)
SELECT ${NAME} AS name, COUNT(DISTINCT o.id) AS photos,
  MIN(CASE WHEN o.t >= '1990-01-01' AND o.t < date(?, '+2 days') THEN CAST(strftime('%Y', o.t) AS INTEGER) END) AS first
FROM o, ${ENTRIES('o.species')} AS j
WHERE name IS NOT NULL GROUP BY name ORDER BY photos DESC, name`;

/** The dated photos of one species by month and 2-hour slot. Binds the owner email, today, then the name. */
const CHANCE_SQL = `${datedCte('species')}
SELECT CAST(strftime('%m', t) AS INTEGER) AS month, CAST(strftime('%H', t) AS INTEGER) / 2 * 2 AS slot, COUNT(*) AS photos
FROM d WHERE species <> '[]' AND EXISTS (SELECT 1 FROM ${ENTRIES('d.species')} AS j WHERE ${NAME} = ?)
GROUP BY month, slot ORDER BY month, slot`;

type SpeciesRow = { name: string; photos: number; first: number | null };
type ChanceRow = { month: number; slot: number; photos: number };

function lifeList(species: SpeciesRow[], today: string): Fact[] {
  if (species.length < MIN_SPECIES) return [];
  const perYear = new Map<number, number>();
  for (const s of species) if (s.first !== null) perYear.set(s.first, (perYear.get(s.first) ?? 0) + 1);
  const current = Number(today.slice(0, 4));
  const year = perYear.has(current) ? current : current - 1;
  let running = 0;
  const byYear = [...perYear.keys()].sort((a, b) => a - b).map((y) => ({ year: y, total: (running += perYear.get(y)!) }));
  return [
    {
      id: 'life-list',
      data: {
        total: species.length,
        year,
        newInYear: perYear.get(year) ?? 0,
        once: species.filter((s) => s.photos === 1).length,
        byYear: byYear.slice(-YEARS_SHOWN),
      },
    },
  ];
}

/** The busiest month of the species, and the slots within that month, so the two always fit each other. */
function bestChance(species: SpeciesRow, rows: ChanceRow[]): Fact[] {
  const months = new Map<number, number>();
  for (const r of rows) months.set(r.month, (months.get(r.month) ?? 0) + r.photos);
  const month = [...months].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  if (month === undefined) return [];
  const slots = rows.filter((r) => r.month === month).map(({ slot, photos }) => ({ slot, photos }));
  const slot = slots.reduce((best, s) => (s.photos > best.photos ? s : best)).slot;
  return [{ id: 'best-chance', data: { species: species.name, photos: species.photos, month, slot, slots } }];
}

/** Two passes over the owner's photos that have species; the Worker handles one row for each species. */
export const wildlifeFacts: TopicBuilder = async (db, email, today) => {
  const species = (await db.prepare(SPECIES_SQL).bind(email, today).all<SpeciesRow>()).results;
  const top = species[0];
  const chance =
    top && top.photos >= MIN_BEST_CHANCE_PHOTOS
      ? bestChance(top, (await db.prepare(CHANCE_SQL).bind(email, today, top.name).all<ChanceRow>()).results)
      : [];
  return [...lifeList(species, today), ...chance];
};
