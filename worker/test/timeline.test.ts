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

  it('rejects a range that ends before it starts with 400', async () => {
    const { status, body } = await get('/timeline?from=2025-07-01&to=2025-06-01');
    expect(status).toBe(400);
    expect(typeof body.error).toBe('string');
  });

  const keysAndIds = (body: any) => body.groups.map((g: any) => [g.key, g.total, g.photos.map((p: any) => p.id)]);

  it('keeps the last instant of a month in its own page and the first instant of the next out', async () => {
    const jun1 = await seed({ dt: '2025-06-01T00:00:00', score: 9 });
    const may31 = await seed({ dt: '2025-05-31T23:59:59', score: 9 });
    const may1 = await seed({ dt: '2025-05-01T00:00:00', score: 9 });
    const apr30 = await seed({ dt: '2025-04-30T23:59:59', score: 9 });
    const p1 = (await get('/timeline?zoom=month&groups=1')).body;
    expect(keysAndIds(p1)).toEqual([['2025-06', 1, [jun1]]]);
    const p2 = (await get(`/timeline?zoom=month&groups=1&cursor=${p1.nextCursor}`)).body;
    expect(keysAndIds(p2)).toEqual([['2025-05', 2, [may31, may1]]]);
    expect(p2.nextCursor).toBe('2025-05');
    const p3 = (await get(`/timeline?zoom=month&groups=1&cursor=${p2.nextCursor}`)).body;
    expect(keysAndIds(p3)).toEqual([['2025-04', 1, [apr30]]]);
    expect(p3.nextCursor).toBeNull();
  });

  it('keeps day boundaries exact at day zoom', async () => {
    const jun1 = await seed({ dt: '2025-06-01T00:00:00' });
    const late = await seed({ dt: '2025-05-31T23:59:59' });
    const early = await seed({ dt: '2025-05-31T00:00:00' });
    const may30 = await seed({ dt: '2025-05-30T23:59:59' });
    const p1 = (await get('/timeline?zoom=day&groups=1&cursor=2025-06-01')).body;
    expect(keysAndIds(p1)).toEqual([['2025-05-31', 2, [late, early]]]);
    const p2 = (await get(`/timeline?zoom=day&groups=2&cursor=${p1.nextCursor}`)).body;
    expect(keysAndIds(p2)).toEqual([['2025-05-30', 1, [may30]]]);
    const all = (await get('/timeline?zoom=day')).body;
    expect(keysAndIds(all)[0]).toEqual(['2025-06-01', 1, [jun1]]);
  });

  it('returns the same groups from a mid-feed cursor at every zoom', async () => {
    const seeded: string[] = [];
    for (const m of ['01', '02', '03', '04', '05', '06'])
      for (const d of ['01', '15', '28']) seeded.push(await seed({ dt: `2024-${m}-${d}T12:00:00`, score: 9 }));
    for (const zoom of ['year', 'month', 'day']) {
      const whole = (await get(`/timeline?zoom=${zoom}&groups=24`)).body;
      const pages: any[] = [];
      let cursor: string | null = null;
      do {
        const page: any = (await get(`/timeline?zoom=${zoom}&groups=4${cursor ? `&cursor=${cursor}` : ''}`)).body;
        pages.push(...page.groups);
        cursor = page.nextCursor;
      } while (cursor);
      expect(pages).toEqual(whole.groups);
      expect(pages.flatMap((g: any) => g.photos.map((p: any) => p.id)).sort()).toEqual([...seeded].sort());
    }
  });

  it('returns dated days and the undated group together on the last day-zoom page', async () => {
    await seed({ dt: '2025-06-02T08:00:00' });
    await seed({ dt: '2025-06-01T08:00:00' });
    const may31 = await seed({ dt: '2025-05-31T08:00:00' });
    const u1 = await seed({ dt: null });
    const u2 = await seed({ dt: 'garbage' });
    const p1 = (await get('/timeline?zoom=day&groups=2')).body;
    expect(p1.nextCursor).toBe('2025-06-01');
    const p2 = (await get('/timeline?zoom=day&groups=2&cursor=2025-06-01')).body;
    expect(keysAndIds(p2)).toEqual([
      ['2025-05-31', 1, [may31]],
      ['undated', 2, expect.arrayContaining([u1, u2])],
    ]);
    expect(p2.nextCursor).toBeNull();
  });

  it('pages to the undated group when the dated days fill a page exactly', async () => {
    await seed({ dt: '2025-06-02T08:00:00' });
    await seed({ dt: '2025-06-01T08:00:00' });
    const u = await seed({ dt: null });
    const p1 = (await get('/timeline?zoom=day&groups=2')).body;
    expect(p1.groups.map((g: any) => g.key)).toEqual(['2025-06-02', '2025-06-01']);
    expect(p1.nextCursor).toBe('2025-06-01');
    const p2 = (await get('/timeline?zoom=day&groups=2&cursor=2025-06-01')).body;
    expect(keysAndIds(p2)).toEqual([['undated', 1, [u]]]);
    expect(p2.nextCursor).toBeNull();
  });

  it('treats malformed dates as undated', async () => {
    const ok = await seed({ dt: '2025-06-02T10:00:00', score: 9 });
    const bad = [];
    for (const dt of ['garbage', '', '2025:06:02 10:00:00', '2025']) bad.push(await seed({ dt, score: 9 }));
    const day = await get('/timeline?zoom=day');
    expect(day.status).toBe(200);
    expect(keysAndIds(day.body)).toEqual([
      ['2025-06-02', 1, [ok]],
      ['undated', 4, expect.arrayContaining(bad)],
    ]);
    for (const zoom of ['month', 'year']) {
      const r = await get(`/timeline?zoom=${zoom}`);
      expect(r.status).toBe(200);
      expect(keysAndIds(r.body)).toEqual([['2025-06', 1, [ok]]]);
    }
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

  it('counts malformed dates as undated', async () => {
    await seed({ dt: D('05') });
    for (const dt of ['garbage', '', '2025:06:02 10:00:00', '2025']) await seed({ dt });
    const { body } = await get('/timeline/buckets');
    expect(body).toEqual({ buckets: [{ month: '2025-05', total: 1 }], undated: 4 });
  });
});
