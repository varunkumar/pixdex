import { COMBINED_SCORE_SQL } from '../db/rating';
import { CAMERA_OFFSET_MINUTES, datedCte, HIT_SCORE, ownedSql } from './common';
import type { Fact, FocalGroup, TopicBuilder } from './types';

const MIN_TOP_LENS_HITS = 20;
const MIN_LENS_PHOTOS = 50;
const MIN_RECIPE_PHOTOS = 50;
const MIN_ZOOM_PHOTOS = 100;
const MIN_YEAR_PHOTOS = 100;
const MIN_CAMERA_PHOTOS = 20;
const ZOOM_BUCKETS = 5;

/** 1 for a hit, 0 for a lower score or none. */
const HIT_SQL = `COALESCE(${COMBINED_SCORE_SQL} >= ${HIT_SCORE}, 0)`;
const SCORE_COLUMNS = 'user_rating, aesthetic_score';

const RECIPE_SQL = `${datedCte(`focal_length, ${SCORE_COLUMNS}`)}
SELECT CAST(strftime('%w', t) AS INTEGER) AS weekday, CAST(strftime('%H', t) AS INTEGER) / 2 * 2 AS slot,
  CASE WHEN focal_length < 35 THEN 'under-35' WHEN focal_length < 70 THEN '35-69' WHEN focal_length < 200 THEN '70-199'
       WHEN focal_length < 400 THEN '200-399' ELSE '400-plus' END AS focal,
  COUNT(*) AS photos, SUM(${HIT_SQL}) AS hits
FROM d WHERE focal_length > 0 GROUP BY weekday, slot, focal`;

const CAMERA_TIME = `datetime(date_time, '+${CAMERA_OFFSET_MINUTES} minutes')`;

/**
 * One row for each lens, camera and year (year NULL for photos with no believable date): the base of every gear fact
 * except the recipe and the zoom bins. `moments` counts the photos that start a new moment: no photo of the same
 * camera in the 2 seconds before. The photos are read once, with the sort that the moments need. Binds today, then
 * the owner email.
 */
const GEAR_SQL = `WITH o AS (
  SELECT lens_model AS lens, camera_model AS camera, focal_length, ${SCORE_COLUMNS},
    CASE WHEN ${CAMERA_TIME} >= '1990-01-01' AND ${CAMERA_TIME} < date(?, '+2 days') THEN ${CAMERA_TIME} END AS t
  FROM photos WHERE ${ownedSql('album')}
)
SELECT NULLIF(lens, '') AS lens, NULLIF(camera, '') AS camera, CAST(strftime('%Y', t) AS INTEGER) AS year,
  COUNT(*) AS photos, SUM(hit) AS hits, MIN(date(t)) AS first, MAX(date(t)) AS last,
  SUM(t IS NOT NULL AND (gap IS NULL OR gap > 2)) AS moments,
  MIN(CASE WHEN focal_length > 0 THEN focal_length END) AS mn, MAX(CASE WHEN focal_length > 0 THEN focal_length END) AS mx,
  COUNT(CASE WHEN focal_length > 0 THEN 1 END) AS focals
FROM (
  SELECT lens, camera, focal_length, t, ${HIT_SQL} AS hit,
    unixepoch(t) - LAG(unixepoch(t)) OVER (PARTITION BY camera ORDER BY unixepoch(t)) AS gap
  FROM o
)
GROUP BY 1, 2, 3`;

/** The photos of one lens in equal focal length bins. Binds the shortest and longest length, the email, the lens. */
export const ZOOM_SQL = `SELECT ${Array.from({ length: ZOOM_BUCKETS }, (_, i) => `SUM(bin = ${i}) AS b${i}`).join(', ')}, SUM(at_max) AS at_max FROM (
  SELECT MIN(${ZOOM_BUCKETS - 1}, CAST((focal_length - ?1) * ${ZOOM_BUCKETS} / (?2 - ?1) AS INTEGER)) AS bin, focal_length >= 0.95 * ?2 AS at_max
  FROM photos WHERE album IN (SELECT name FROM albums WHERE owner_email = ?3) AND lens_model = ?4 AND focal_length > 0
)`;

type GearRow = {
  lens: string | null; camera: string | null; year: number | null; photos: number; hits: number; first: string | null; last: string | null;
  moments: number; mn: number | null; mx: number | null; focals: number;
};
type LensRow = { lens: string; photos: number; hits: number };
type RecipeRow = { weekday: number; slot: number; focal: FocalGroup; photos: number; hits: number };
type Zoom = { lens: string; min: number; max: number; photos: number };
type ZoomRow = Record<`b${number}`, number | null> & { at_max: number | null };
type BurstRow = { year: number; photos: number; moments: number };
type CameraYearRow = { year: number; camera: string | null; photos: number; hits: number; first: string; last: string };

/** Binary text order with NULL first, as SQLite sorts. */
const text = (a: string | null, b: string | null) => (a === b ? 0 : a === null || (b !== null && a < b) ? -1 : 1);

/** Adds up the rows that have the same key; a row with a NULL key is left out. */
function groupBy<R, G>(rows: R[], key: (r: R) => string | null, start: (r: R) => G, add: (g: G, r: R) => void): G[] {
  const groups = new Map<string, G>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = start(r)));
    add(g, r);
  }
  return [...groups.values()];
}

const byLens = (rows: GearRow[]): LensRow[] =>
  groupBy(
    rows,
    (r) => r.lens,
    (r) => ({ lens: r.lens!, photos: 0, hits: 0 }),
    (g, r) => {
      g.photos += r.photos;
      g.hits += r.hits;
    }
  ).sort((a, b) => text(a.lens, b.lens));

/** Dated photos by year and camera, in that order. */
const byCameraYear = (rows: GearRow[]): CameraYearRow[] =>
  groupBy(
    rows,
    (r) => (r.year === null ? null : JSON.stringify([r.year, r.camera])),
    (r) => ({ year: r.year!, camera: r.camera, photos: 0, hits: 0, first: r.first!, last: r.last! }),
    (g, r) => {
      g.photos += r.photos;
      g.hits += r.hits;
      if (r.first! < g.first) g.first = r.first!;
      if (r.last! > g.last) g.last = r.last!;
    }
  ).sort((a, b) => a.year - b.year || text(a.camera, b.camera));

/** Dated photos with a camera, and their moments, by year. */
const byBurstYear = (rows: GearRow[]): BurstRow[] =>
  groupBy(
    rows,
    (r) => (r.year === null || r.camera === null ? null : String(r.year)),
    (r) => ({ year: r.year!, photos: 0, moments: 0 }),
    (g, r) => {
      g.photos += r.photos;
      g.moments += r.moments;
    }
  ).sort((a, b) => a.year - b.year);

/** The most used lens that zooms: its longest focal length is at least 1.5 times its shortest. */
function zoomLens(rows: GearRow[]): Zoom | undefined {
  return groupBy(
    rows,
    (r) => (r.focals > 0 ? r.lens : null),
    (r) => ({ lens: r.lens!, min: r.mn!, max: r.mx!, photos: 0 }),
    (g, r) => {
      g.min = Math.min(g.min, r.mn!);
      g.max = Math.max(g.max, r.mx!);
      g.photos += r.focals;
    }
  )
    .filter((z) => z.max >= 1.5 * z.min && z.photos >= MIN_ZOOM_PHOTOS)
    .sort((a, b) => b.photos - a.photos || text(a.lens, b.lens))[0];
}

const rate = (r: { hits: number; photos: number }) => r.hits / r.photos;

function lensFacts(rows: LensRow[]): Fact[] {
  const facts: Fact[] = [];
  const knownLensPhotos = rows.reduce((n, r) => n + r.photos, 0);
  const top = [...rows].sort((a, b) => b.hits - a.hits || rate(b) - rate(a))[0];
  if (top && top.hits >= MIN_TOP_LENS_HITS) {
    facts.push({ id: 'top-lens', data: { lens: top.lens, hits: top.hits, photos: top.photos, knownLensPhotos } });
  }
  const busy = rows.filter((r) => r.photos >= MIN_LENS_PHOTOS).sort((a, b) => rate(b) - rate(a) || b.photos - a.photos);
  if (busy.length >= 2 && busy[0].hits > 0) {
    facts.push({ id: 'hit-rate', data: { lenses: busy.slice(0, 4).map(({ lens, hits, photos }) => ({ lens, hits, photos })) } });
  }
  return facts;
}

function recipeFacts(rows: RecipeRow[]): Fact[] {
  const allPhotos = rows.reduce((n, r) => n + r.photos, 0);
  const allHits = rows.reduce((n, r) => n + r.hits, 0);
  const best = rows.filter((r) => r.photos >= MIN_RECIPE_PHOTOS).sort((a, b) => rate(b) - rate(a) || b.photos - a.photos)[0];
  if (!best || rate(best) <= allHits / allPhotos) return [];
  const { weekday, slot, focal, hits, photos } = best;
  return [{ id: 'recipe', data: { weekday, slot, focal, hits, photos, allHits, allPhotos } }];
}

function zoomFacts({ lens, min, max, photos }: Zoom, row: ZoomRow): Fact[] {
  const edge = (i: number) => Math.round(min + ((max - min) * i) / ZOOM_BUCKETS);
  const buckets = Array.from({ length: ZOOM_BUCKETS }, (_, i) => ({ from: edge(i), to: edge(i + 1), photos: row[`b${i}`] ?? 0 }));
  return [{ id: 'zoom', data: { lens, min, max, atMax: row.at_max ?? 0, photos, buckets } }];
}

function burstFacts(rows: BurstRow[]): Fact[] {
  const years = rows.filter((r) => r.photos >= MIN_YEAR_PHOTOS).map(({ year, photos, moments }) => ({ year, photos, moments }));
  return years.length < 2 ? [] : [{ id: 'burst', data: { years } }];
}

function progressFacts(rows: CameraYearRow[]): Fact[] {
  const byYear = new Map<number, { year: number; photos: number; hits: number; camera: string | null; used: number }>();
  for (const r of rows) {
    const y = byYear.get(r.year) ?? { year: r.year, photos: 0, hits: 0, camera: null, used: 0 };
    y.photos += r.photos;
    y.hits += r.hits;
    if (r.camera && r.photos > y.used) {
      y.camera = r.camera;
      y.used = r.photos;
    }
    byYear.set(r.year, y);
  }
  const years = [...byYear.values()]
    .filter((y) => y.photos >= MIN_YEAR_PHOTOS)
    .map(({ year, photos, hits, camera }) => ({ year, photos, hits, camera }));
  return years.length < 2 || years.every((y) => y.hits === 0) ? [] : [{ id: 'progress', data: { years } }];
}

function cameraFacts(rows: CameraYearRow[]): Fact[] {
  const byCamera = new Map<string, { camera: string; first: string; last: string; photos: number }>();
  for (const r of rows) {
    if (!r.camera) continue;
    const c = byCamera.get(r.camera);
    if (!c) {
      byCamera.set(r.camera, { camera: r.camera, first: r.first, last: r.last, photos: r.photos });
      continue;
    }
    c.photos += r.photos;
    if (r.first < c.first) c.first = r.first;
    if (r.last > c.last) c.last = r.last;
  }
  const busy = [...byCamera.values()].filter((c) => c.photos >= MIN_CAMERA_PHOTOS).sort((a, b) => b.photos - a.photos);
  if (busy.length < 2) return [];
  const cameras = busy.slice(0, 6).sort((a, b) => a.first.localeCompare(b.first) || a.camera.localeCompare(b.camera));
  return [{ id: 'cameras', data: { total: byCamera.size, cameras } }];
}

/**
 * The gear recipe, cached apart from the other gear facts: one grouped pass over the owner's dated photos.
 * `small` says that there are too few photos for any recipe, so the caller should look again soon.
 */
export async function recipeBuild(db: D1Database, email: string, today: string): Promise<{ facts: Fact[]; small: boolean }> {
  const { results } = await db.prepare(RECIPE_SQL).bind(email, today).all<RecipeRow>();
  return { facts: recipeFacts(results), small: results.reduce((n, r) => n + r.photos, 0) < MIN_RECIPE_PHOTOS };
}

/** The recipe tile comes after the two lens tiles. */
export function withRecipe(facts: Fact[], recipe: Fact[]): Fact[] {
  const at = facts.filter((f) => f.id === 'top-lens' || f.id === 'hit-rate').length;
  return [...facts.slice(0, at), ...recipe, ...facts.slice(at)];
}

/** Two passes over the owner's photos (one grouped, one for the zoom bins); the Worker handles grouped rows only. */
export const gearMainFacts: TopicBuilder = async (db, email, today) => {
  const { results } = await db.prepare(GEAR_SQL).bind(today, email).all<GearRow>();
  const zoom = zoomLens(results);
  const bins = zoom ? await db.prepare(ZOOM_SQL).bind(zoom.min, zoom.max, email, zoom.lens).first<ZoomRow>() : null;
  const cameraYears = byCameraYear(results);
  return [
    ...lensFacts(byLens(results)),
    ...(zoom && bins ? zoomFacts(zoom, bins) : []),
    ...burstFacts(byBurstYear(results)),
    ...progressFacts(cameraYears),
    ...cameraFacts(cameraYears),
  ];
};

/** Every gear fact, calculated now (the route caches the two parts apart). */
export const gearFacts: TopicBuilder = async (db, email, today) => {
  const [main, recipe] = await Promise.all([gearMainFacts(db, email, today), recipeBuild(db, email, today)]);
  return withRecipe(main, recipe.facts);
};
