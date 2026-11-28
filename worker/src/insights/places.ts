import { datedCte } from './common';
import type { Fact, TopicBuilder } from './types';

const MIN_GPS_PHOTOS = 100;
const MIN_PLACE_PHOTOS = 20;

/** GPS 0,0 is what some cameras write with no fix. */
const WITH_GPS = `latitude IS NOT NULL AND longitude IS NOT NULL AND NOT (latitude = 0 AND longitude = 0)`;

/**
 * One row for each 0.1 degree cell, place and shooting day, in cell order. Both facts come from these rows, so the
 * photos are read once. Binds the email, then today.
 */
const GPS_SQL = `${datedCte('latitude, longitude, place')}
SELECT round(latitude, 1) AS a, round(longitude, 1) AS o, place, date(t) AS day, COUNT(*) AS photos,
  SUM(latitude) AS lat, SUM(longitude) AS lon
FROM d WHERE ${WITH_GPS} GROUP BY a, o, place, day`;

type GpsRow = { a: number; o: number; place: string | null; day: string; photos: number; lat: number; lon: number };
type CellRow = { lat: number; lon: number; photos: number; days: number; last: string; place: string | null };
type PlaceRow = { place: string; photos: number; days: number; first: number };

/** Each cell's average position, shooting days, latest day and one place name. */
function toCells(rows: GpsRow[]): CellRow[] {
  const cells = new Map<string, { lat: number; lon: number; photos: number; days: Set<string>; last: string; place: string | null }>();
  for (const r of rows) {
    const key = `${r.a},${r.o}`;
    const c = cells.get(key) ?? { lat: 0, lon: 0, photos: 0, days: new Set<string>(), last: '', place: null };
    c.lat += r.lat;
    c.lon += r.lon;
    c.photos += r.photos;
    c.days.add(r.day);
    if (r.day > c.last) c.last = r.day;
    if (r.place && (c.place === null || r.place > c.place)) c.place = r.place;
    cells.set(key, c);
  }
  return [...cells.values()].map((c) => ({ ...c, lat: c.lat / c.photos, lon: c.lon / c.photos, days: c.days.size }));
}

/** The named places, most shooting days first. */
function toPlaces(rows: GpsRow[]): PlaceRow[] {
  const found = new Map<string, { photos: number; days: Set<string>; first: string }>();
  for (const r of rows) {
    if (!r.place) continue;
    const p = found.get(r.place) ?? { photos: 0, days: new Set<string>(), first: r.day };
    p.photos += r.photos;
    p.days.add(r.day);
    if (r.day < p.first) p.first = r.day;
    found.set(r.place, p);
  }
  return [...found]
    .map(([place, p]) => ({ place, photos: p.photos, days: p.days.size, first: Number(p.first.slice(0, 4)) }))
    .sort((x, y) => y.days - x.days || y.photos - x.photos || (x.place < y.place ? -1 : 1));
}

function distanceKm(a: CellRow, b: CellRow): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** From the usual spot (the cell with the most days) to the farthest cell. One distance for each cell. */
function travel(cells: CellRow[], gpsPhotos: number): Fact[] {
  if (gpsPhotos < MIN_GPS_PHOTOS) return [];
  const home = cells.reduce((best, c) => (c.days > best.days || (c.days === best.days && c.photos > best.photos) ? c : best));
  let far = home;
  let km = 0;
  for (const cell of cells) {
    const d = distanceKm(home, cell);
    if (d > km) [far, km] = [cell, d];
  }
  // Under a kilometre there is nothing to tell.
  if (km < 1) return [];
  return [{ id: 'travel', data: { km: Math.round(km), place: far.place, date: far.last, gpsPhotos } }];
}

function places(rows: PlaceRow[], gpsPhotos: number, today: string): Fact[] {
  if (rows.reduce((n, r) => n + r.photos, 0) < MIN_PLACE_PHOTOS) return [];
  const current = Number(today.slice(0, 4));
  const year = rows.some((r) => r.first === current) ? current : current - 1;
  const top = rows.slice(0, 3).map(({ place, days, photos }) => ({ place, days, photos }));
  return [{ id: 'places', data: { year, newCount: rows.filter((r) => r.first === year).length, top, gpsPhotos } }];
}

/** One pass over the owner's photos; the Worker handles at most one row for each photo with GPS. */
export const placesFacts: TopicBuilder = async (db, email, today) => {
  const { results } = await db.prepare(GPS_SQL).bind(email, today).all<GpsRow>();
  const gpsPhotos = results.reduce((n, r) => n + r.photos, 0);
  if (gpsPhotos === 0) return [];
  return [...travel(toCells(results), gpsPhotos), ...places(toPlaces(results), gpsPhotos, today)];
};
