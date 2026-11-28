import { COMBINED_SCORE_SQL } from '../db/rating';
import { datedCte, HIT_SCORE, ownedSql } from './common';
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

/** Binds the owner email. */
const LENS_SQL = `SELECT lens_model AS lens, COUNT(*) AS photos, SUM(${HIT_SQL}) AS hits
FROM photos WHERE ${ownedSql('album')} AND lens_model <> '' GROUP BY lens_model`;

const RECIPE_SQL = `${datedCte(`focal_length, ${SCORE_COLUMNS}`)}
SELECT CAST(strftime('%w', t) AS INTEGER) AS weekday, CAST(strftime('%H', t) AS INTEGER) / 2 * 2 AS slot,
  CASE WHEN focal_length < 35 THEN 'under-35' WHEN focal_length < 70 THEN '35-69' WHEN focal_length < 200 THEN '70-199'
       WHEN focal_length < 400 THEN '200-399' ELSE '400-plus' END AS focal,
  COUNT(*) AS photos, SUM(${HIT_SQL}) AS hits
FROM d WHERE focal_length > 0 GROUP BY weekday, slot, focal`;

/** The most used lens that zooms (observed longest focal length 1.5 times the shortest), in equal bins. Binds email twice. */
export const ZOOM_SQL = `WITH z AS MATERIALIZED (
  SELECT lens_model AS lens, MIN(focal_length) AS mn, MAX(focal_length) AS mx, COUNT(*) AS n
  FROM photos WHERE ${ownedSql('album')} AND lens_model <> '' AND focal_length > 0
  GROUP BY lens_model HAVING mx >= 1.5 * mn AND n >= ${MIN_ZOOM_PHOTOS} ORDER BY n DESC, lens LIMIT 1
)
SELECT z.lens, z.mn, z.mx, z.n, MIN(${ZOOM_BUCKETS - 1}, CAST((p.focal_length - z.mn) * ${ZOOM_BUCKETS} / (z.mx - z.mn) AS INTEGER)) AS bin,
  COUNT(*) AS photos, SUM(p.focal_length >= 0.95 * z.mx) AS at_max
FROM z CROSS JOIN photos p ON p.lens_model = z.lens
WHERE ${ownedSql('p.album')} AND p.focal_length > 0 GROUP BY bin`;

const BURST_SQL = `${datedCte('camera_model')},
s AS (SELECT camera_model AS camera, CAST(strftime('%Y', t) AS INTEGER) AS year, unixepoch(t) AS sec FROM d WHERE camera_model <> ''),
g AS (SELECT year, sec - LAG(sec) OVER (PARTITION BY camera ORDER BY sec) AS gap FROM s)
SELECT year, COUNT(*) AS photos, SUM(gap IS NULL OR gap > 2) AS moments FROM g GROUP BY year ORDER BY year`;

const CAMERA_YEARS_SQL = `${datedCte(`camera_model, ${SCORE_COLUMNS}`)}
SELECT CAST(strftime('%Y', t) AS INTEGER) AS year, NULLIF(camera_model, '') AS camera, COUNT(*) AS photos,
  SUM(${HIT_SQL}) AS hits, MIN(date(t)) AS first, MAX(date(t)) AS last
FROM d GROUP BY year, camera ORDER BY year, camera`;

type LensRow = { lens: string; photos: number; hits: number };
type RecipeRow = { weekday: number; slot: number; focal: FocalGroup; photos: number; hits: number };
type ZoomRow = { lens: string; mn: number; mx: number; n: number; bin: number; photos: number; at_max: number };
type BurstRow = { year: number; photos: number; moments: number };
type CameraYearRow = { year: number; camera: string | null; photos: number; hits: number; first: string; last: string };

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

function zoomFacts(rows: ZoomRow[]): Fact[] {
  if (rows.length === 0) return [];
  const { lens, mn: min, mx: max, n: photos } = rows[0];
  const edge = (i: number) => Math.round(min + ((max - min) * i) / ZOOM_BUCKETS);
  const buckets = Array.from({ length: ZOOM_BUCKETS }, (_, i) => ({
    from: edge(i),
    to: edge(i + 1),
    photos: rows.find((r) => r.bin === i)?.photos ?? 0,
  }));
  const atMax = rows.reduce((n, r) => n + r.at_max, 0);
  return [{ id: 'zoom', data: { lens, min, max, atMax, photos, buckets } }];
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

/** Five passes over the owner's photos (zoom reads them twice); the Worker handles grouped rows only. */
export const gearFacts: TopicBuilder = async (db, email, today) => {
  const [lenses, recipe, zoom, burst, cameraYears] = await Promise.all([
    db.prepare(LENS_SQL).bind(email).all<LensRow>(),
    db.prepare(RECIPE_SQL).bind(email, today).all<RecipeRow>(),
    db.prepare(ZOOM_SQL).bind(email, email).all<ZoomRow>(),
    db.prepare(BURST_SQL).bind(email, today).all<BurstRow>(),
    db.prepare(CAMERA_YEARS_SQL).bind(email, today).all<CameraYearRow>(),
  ]);
  return [
    ...lensFacts(lenses.results),
    ...recipeFacts(recipe.results),
    ...zoomFacts(zoom.results),
    ...burstFacts(burst.results),
    ...progressFacts(cameraYears.results),
    ...cameraFacts(cameraYears.results),
  ];
};
