import { CAMERA_OFFSET_MINUTES, ownedSql } from './common';
import type { Fact, TopicBuilder } from './types';

const MIN_SPECIES = 5;
const MIN_BEST_CHANCE_PHOTOS = 30;
const YEARS_SHOWN = 5;

/** The stored species list as rows; text that is not JSON counts as no species. */
const ENTRIES = (column: string) => `json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END)`;
/** One entry's name; NULL for an entry that is not an object. */
const NAME = `CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.common') END`;

/** The camera time of a photo. */
const CAMERA_TIME = `datetime(date_time, '+${CAMERA_OFFSET_MINUTES} minutes')`;

/**
 * One row for each species, month and 2-hour slot (month and slot are NULL for photos with no believable date).
 * Both facts come from these rows, so the photos are read once. A photo counts once for each species it shows.
 * Binds today, then the owner email.
 */
const SPECIES_SQL = `WITH o AS (
  SELECT id, species, CASE WHEN ${CAMERA_TIME} >= '1990-01-01' AND ${CAMERA_TIME} < date(?, '+2 days') THEN ${CAMERA_TIME} END AS t
  FROM photos WHERE ${ownedSql('album')} AND species <> '[]'
)
SELECT ${NAME} AS name, CAST(strftime('%m', o.t) AS INTEGER) AS month, CAST(strftime('%H', o.t) AS INTEGER) / 2 * 2 AS slot,
  COUNT(DISTINCT o.id) AS photos, MIN(CAST(strftime('%Y', o.t) AS INTEGER)) AS first
FROM o, ${ENTRIES('o.species')} AS j
WHERE name IS NOT NULL GROUP BY name, month, slot ORDER BY name, month, slot`;

type Row = { name: string; month: number | null; slot: number | null; photos: number; first: number | null };
type SpeciesRow = { name: string; photos: number; first: number | null };
type ChanceRow = { month: number; slot: number; photos: number };

/** Each species with its photos and first believable year, most photographed first. */
function toSpecies(rows: Row[]): SpeciesRow[] {
  const found = new Map<string, SpeciesRow>();
  for (const r of rows) {
    const s = found.get(r.name) ?? { name: r.name, photos: 0, first: null };
    s.photos += r.photos;
    if (r.first !== null && (s.first === null || r.first < s.first)) s.first = r.first;
    found.set(r.name, s);
  }
  // The rows come in name order, and the sort keeps it for equal counts.
  return [...found.values()].sort((a, b) => b.photos - a.photos);
}

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

/** One pass over the owner's photos that have species. */
export const wildlifeFacts: TopicBuilder = async (db, email, today) => {
  const rows = (await db.prepare(SPECIES_SQL).bind(today, email).all<Row>()).results;
  const species = toSpecies(rows);
  const top = species[0];
  const chance =
    top && top.photos >= MIN_BEST_CHANCE_PHOTOS
      ? bestChance(top, rows.filter((r): r is Row & ChanceRow => r.name === top.name && r.month !== null))
      : [];
  return [...lifeList(species, today), ...chance];
};
