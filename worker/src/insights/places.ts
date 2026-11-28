import { datedCte } from './common';
import type { Fact, TopicBuilder } from './types';

const MIN_GPS_PHOTOS = 100;
const MIN_PLACE_PHOTOS = 20;

/** GPS 0,0 is what some cameras write with no fix. */
const WITH_GPS = `latitude IS NOT NULL AND longitude IS NOT NULL AND NOT (latitude = 0 AND longitude = 0)`;

/** One row for each 0.1 degree cell: its average position, shooting days and latest day. Binds the email, then today. */
const CELLS_SQL = `${datedCte('latitude, longitude, place')}
SELECT AVG(latitude) AS lat, AVG(longitude) AS lon, COUNT(*) AS photos, COUNT(DISTINCT date(t)) AS days,
  MAX(date(t)) AS last, MAX(NULLIF(place, '')) AS place
FROM d WHERE ${WITH_GPS} GROUP BY round(latitude, 1), round(longitude, 1)`;

const PLACES_SQL = `${datedCte('latitude, longitude, place')}
SELECT place, COUNT(*) AS photos, COUNT(DISTINCT date(t)) AS days, CAST(strftime('%Y', MIN(t)) AS INTEGER) AS first
FROM d WHERE ${WITH_GPS} AND place <> '' GROUP BY place ORDER BY days DESC, photos DESC, place`;

type CellRow = { lat: number; lon: number; photos: number; days: number; last: string; place: string | null };
type PlaceRow = { place: string; photos: number; days: number; first: number };

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

/** Two passes over the owner's photos; the Worker measures grouped cells only. */
export const placesFacts: TopicBuilder = async (db, email, today) => {
  const [cells, named] = await Promise.all([
    db.prepare(CELLS_SQL).bind(email, today).all<CellRow>(),
    db.prepare(PLACES_SQL).bind(email, today).all<PlaceRow>(),
  ]);
  const gpsPhotos = cells.results.reduce((n, c) => n + c.photos, 0);
  if (gpsPhotos === 0) return [];
  return [...travel(cells.results, gpsPhotos), ...places(named.results, gpsPhotos, today)];
};
