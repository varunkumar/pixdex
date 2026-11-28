import { env, SELF } from 'cloudflare:test';
import { readHeaders } from './helpers';

let n = 0;

/** Inserts one photo. `dt` is date_time, `score` is aesthetic_score, any other key is a photos column. */
export async function seedPhoto(p: { dt?: string | null; album?: string; score?: number | null; [column: string]: unknown } = {}): Promise<string> {
  const { dt = null, album = 'A', score = null, ...columns } = p;
  const id = (columns.id as string | undefined) ?? `ins${++n}`;
  const row: Record<string, unknown> = {
    id, content_hash: `h-${id}`, source: 'local', filename: `${id}.jpg`, subjects: '[]', album, date_time: dt, aesthetic_score: score,
    model_provider: 'ollama', model_name: 'm', search_text: '', search_primary: '', last_indexed: '2026-09-18T00:00:00.000Z',
    ...columns,
  };
  const keys = Object.keys(row);
  await env.DB.prepare(`INSERT INTO photos (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .bind(...keys.map((k) => row[k]))
    .run();
  return id;
}

/** Inserts `count` photos, one after another. */
export async function seedMany(count: number, make: (i: number) => Parameters<typeof seedPhoto>[0]): Promise<void> {
  for (let i = 0; i < count; i++) await seedPhoto(make(i));
}

export async function getJson(path: string, email?: string): Promise<{ status: number; body: any }> {
  const r = await SELF.fetch(`https://example.com${path}`, { headers: readHeaders(email) });
  const json = r.headers.get('content-type')?.includes('json');
  return { status: r.status, body: json ? await r.json() : await r.text() };
}

export async function clearInsights(): Promise<void> {
  for (const table of ['insights_cache', 'faces', 'person_references', 'person_labels', 'persons', 'photos']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}
