/** Raise this when a fact definition or a cached shape changes: older cache rows are then recalculated. */
export const INSIGHTS_VERSION = 1;
/**
 * `date_time` holds the camera clock read as India time and saved as UTC (all indexing used a machine set to
 * India time), so adding this gives the camera clock again.
 */
export const CAMERA_OFFSET_MINUTES = 330;
/** A photo with this combined score or more is a "hit". */
export const HIT_SCORE = 8;

/** The India date (YYYY-MM-DD) at `now`. */
export function indiaDate(now: Date): string {
  return new Date(now.getTime() + CAMERA_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** `column` (a photos album column) is one of the albums the user owns. Binds the email. Shared albums do not count. */
export const ownedSql = (column: string): string => `${column} IN (SELECT name FROM albums WHERE owner_email = ?)`;

/**
 * The start of every date-based insight: `o` is the owner's photos with the camera time `t`
 * ('YYYY-MM-DD HH:MM:SS'), `d` those with a believable date. `t` is NULL for text SQLite cannot read as a date,
 * so such rows fail both bounds. Binds the owner email, then today's India date.
 */
export const datedCte = (columns: string): string =>
  `WITH o AS (SELECT ${columns}, datetime(date_time, '+${CAMERA_OFFSET_MINUTES} minutes') AS t FROM photos WHERE ${ownedSql('album')}),
d AS (SELECT * FROM o WHERE t >= '1990-01-01' AND t < date(?, '+2 days'))`;

/**
 * The cached value for (user, topic) when it was built for `day` with the current version, else `build()`, which
 * then replaces the row. One primary-key read; one upsert on a miss. Two first requests may both build.
 */
export async function cached<T>(db: D1Database, email: string, topic: string, day: string, build: () => Promise<T>): Promise<T> {
  const row = await db
    .prepare('SELECT data FROM insights_cache WHERE email = ? AND topic = ? AND day = ? AND version = ?')
    .bind(email, topic, day, INSIGHTS_VERSION)
    .first<{ data: string }>();
  if (row) return JSON.parse(row.data) as T;
  const value = await build();
  await db
    .prepare(
      `INSERT INTO insights_cache (email, topic, day, version, data, computed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email, topic) DO UPDATE SET day = excluded.day, version = excluded.version, data = excluded.data, computed_at = excluded.computed_at`
    )
    .bind(email, topic, day, INSIGHTS_VERSION, JSON.stringify(value), new Date().toISOString())
    .run();
  return value;
}
