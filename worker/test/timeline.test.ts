import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

type Seed = { dt: string | null; score?: number | null; rating?: number | null; album?: string };
let n = 0;

async function seed(s: Seed): Promise<string> {
  const id = `p${++n}`;
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, subjects, album, date_time, aesthetic_score, user_rating, model_provider, model_name, search_text, search_primary, last_indexed)
     VALUES (?,?,'local',?,'[]',?,?,?,?, 'ollama', 'm', '', '', '2026-09-18T00:00:00.000Z')`
  )
    .bind(id, `h-${id}`, `${id}.jpg`, s.album ?? 'A', s.dt, s.score ?? null, s.rating ?? null)
    .run();
  return id;
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await SELF.fetch(`https://example.com${path}`, {
    headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
  });
  return { status: r.status, body: await r.json() };
}

const D = (m: string, day = '10') => `2025-${m}-${day}T10:00:00`;

describe('GET /timeline', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM faces').run();
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('month zoom shows photos at or above the threshold, topped up to the minimum', async () => {
    for (const [i, s] of [9, 8, 7, 5, 2].entries()) await seed({ dt: D('05', `0${i + 1}`), score: s });
    for (const [i, s] of [5, 4, 3, 2].entries()) await seed({ dt: D('04', `0${i + 1}`), score: s });
    const { body } = await get('/timeline?zoom=month');
    const may = body.groups.find((g: any) => g.key === '2025-05');
    const apr = body.groups.find((g: any) => g.key === '2025-04');
    expect(may).toMatchObject({ total: 5, shown: 3 });
    expect(may.photos.length).toBe(3);
    expect(apr).toMatchObject({ total: 4, shown: 3 });
  });

  it('month with only unrated photos shows none but keeps its total', async () => {
    await seed({ dt: D('03') });
    await seed({ dt: D('03', '11') });
    const { body } = await get('/timeline?zoom=month');
    expect(body.groups).toEqual([{ key: '2025-03', total: 2, shown: 0, photos: [] }]);
  });

  it('year zoom caps at 6 per month', async () => {
    for (let i = 1; i <= 8; i++) await seed({ dt: D('06', `0${i}`), score: 9 });
    const { body } = await get('/timeline?zoom=year');
    expect(body.groups[0]).toMatchObject({ key: '2025-06', total: 8, shown: 6 });
  });

  it('day zoom returns everything grouped by day with undated last', async () => {
    await seed({ dt: '2025-06-02T08:00:00' });
    await seed({ dt: '2025-06-02T09:00:00', score: 3 });
    await seed({ dt: '2025-06-01T09:00:00', score: 9 });
    await seed({ dt: null });
    const { body } = await get('/timeline?zoom=day');
    expect(body.groups.map((g: any) => [g.key, g.shown, g.total])).toEqual([
      ['2025-06-02', 2, 2],
      ['2025-06-01', 1, 1],
      ['undated', 1, 1],
    ]);
  });

  it('undated photos never appear at month or year zoom', async () => {
    await seed({ dt: null, score: 9 });
    expect((await get('/timeline?zoom=month')).body.groups).toEqual([]);
    expect((await get('/timeline?zoom=year')).body.groups).toEqual([]);
  });

  it('orders photos inside a group by date_time descending', async () => {
    const a = await seed({ dt: '2025-05-01T10:00:00', score: 9 });
    const b = await seed({ dt: '2025-05-20T10:00:00', score: 7 });
    const c = await seed({ dt: '2025-05-10T10:00:00', score: 8 });
    const { body } = await get('/timeline?zoom=month');
    expect(body.groups[0].photos.map((p: any) => p.id)).toEqual([b, c, a]);
  });

  it('pages by cursor without overlap and ends with null', async () => {
    for (const m of ['01', '02', '03', '04', '05']) await seed({ dt: D(m), score: 9 });
    const p1 = (await get('/timeline?zoom=month&groups=2')).body;
    expect(p1.groups.map((g: any) => g.key)).toEqual(['2025-05', '2025-04']);
    expect(p1.nextCursor).toBe('2025-04');
    const p2 = (await get(`/timeline?zoom=month&groups=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.groups.map((g: any) => g.key)).toEqual(['2025-03', '2025-02']);
    const p3 = (await get(`/timeline?zoom=month&groups=2&cursor=${p2.nextCursor}`)).body;
    expect(p3.groups.map((g: any) => g.key)).toEqual(['2025-01']);
    expect(p3.nextCursor).toBeNull();
  });

  it('pages day zoom through to the undated group', async () => {
    await seed({ dt: '2025-06-02T08:00:00' });
    await seed({ dt: null });
    const p1 = (await get('/timeline?zoom=day&groups=1')).body;
    expect(p1.nextCursor).toBe('2025-06-02');
    const p2 = (await get(`/timeline?zoom=day&groups=1&cursor=2025-06-02`)).body;
    expect(p2.groups.map((g: any) => g.key)).toEqual(['undated']);
    expect(p2.nextCursor).toBeNull();
  });

  it('owner rating dominates the model score', async () => {
    const id = await seed({ dt: D('05'), score: 2, rating: 5 });
    for (let i = 1; i <= 4; i++) await seed({ dt: D('05', `0${i}`), score: 9 });
    const { body } = await get('/timeline?zoom=month');
    expect(body.groups[0].photos.map((p: any) => p.id)).toContain(id);
    expect(body.groups[0].shown).toBe(5);
  });

  it('filters by album', async () => {
    await seed({ dt: D('05'), score: 9, album: 'A' });
    await seed({ dt: D('04'), score: 9, album: 'B' });
    const { body } = await get('/timeline?zoom=month&album=B');
    expect(body.groups.map((g: any) => g.key)).toEqual(['2025-04']);
  });

  it('filters by people', async () => {
    const a = await seed({ dt: D('05'), score: 9 });
    await seed({ dt: D('04'), score: 9 });
    await env.DB.prepare(
      `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, person_id, assign_status, created_at)
       VALUES ('f1',?,0,0,0.1,0.1,0.9,x'00','m','per1','confirmed','t')`
    )
      .bind(a)
      .run();
    const { body } = await get('/timeline?zoom=month&people=per1');
    expect(body.groups.map((g: any) => g.key)).toEqual(['2025-05']);
  });

  it('from/to bound the feed so a jump starts at the chosen month', async () => {
    await seed({ dt: D('05'), score: 9 });
    await seed({ dt: D('03'), score: 9 });
    await seed({ dt: D('02'), score: 9 });
    const { body } = await get('/timeline?zoom=month&to=2025-03-31');
    expect(body.groups.map((g: any) => g.key)).toEqual(['2025-03', '2025-02']);
  });

  it('rejects bad input with 400', async () => {
    expect((await get('/timeline?zoom=week')).status).toBe(400);
    expect((await get('/timeline?from=nope')).status).toBe(400);
    expect((await get('/timeline?groups=0')).status).toBe(400);
    expect((await get('/timeline?groups=25')).status).toBe(400);
  });
});

describe('GET /timeline/buckets', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('returns true monthly totals newest first plus the undated count', async () => {
    await seed({ dt: D('05') });
    await seed({ dt: D('05', '11'), score: 9 });
    await seed({ dt: D('03'), score: 1 });
    await seed({ dt: null });
    await seed({ dt: null, album: 'B' });
    const { body } = await get('/timeline/buckets');
    expect(body).toEqual({
      buckets: [
        { month: '2025-05', total: 2 },
        { month: '2025-03', total: 1 },
      ],
      undated: 2,
    });
    const b = (await get('/timeline/buckets?album=B')).body;
    expect(b).toEqual({ buckets: [], undated: 1 });
  });
});
