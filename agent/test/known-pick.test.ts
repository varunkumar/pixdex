import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGallery, saveGallery, type Gallery, type KnownPerson } from '../src/known/gallery';
import { createCandidateStore, gatherCandidates, type PersonCandidates } from '../src/known/pick/candidates';
import { lowCosinePicks, suggest } from '../src/known/pick/scoring';
import { createPickApp, startPickServer, type PickRequest } from '../src/known/pick/server';

const DIM = 512;
function vec(axis: number, tilt = 0, amount = 0): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  if (amount) v[tilt] = amount;
  let s = 0;
  for (const x of v) s += x * x;
  return v.map((x) => x / Math.sqrt(s));
}
const b64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const face = (v: Float32Array) => ({ bbox: [0, 0, 10, 10] as [number, number, number, number], detScore: 0.9, embedding: v });
const photo = (title: string, faces: Float32Array[]) => ({
  title,
  license: 'CC BY 4.0',
  width: 100,
  height: 100,
  contentType: 'image/jpeg',
  image: Buffer.from(`img-${title}`),
  faces: faces.map(face),
});

const PEOPLE: KnownPerson[] = [
  { id: 'Q1', name: 'Ada', aliases: ['A'] },
  { id: 'Q2', name: 'Bob', aliases: [] },
];
// Q1: three single faces near axis 0 plus a group photo with a matching face (axis 0 tilted) and a stranger.
const CANDS: Record<string, PersonCandidates> = {
  Q1: {
    id: 'Q1',
    model: 'm1',
    photos: [
      photo('File:a.jpg', [vec(0, 1, 0.1)]),
      photo('File:b.jpg', [vec(0, 2, 0.1)]),
      photo('File:c.jpg', [vec(0, 3, 0.1)]),
      photo('File:g.jpg', [vec(7), vec(0, 4, 0.2)]),
    ],
  },
  Q2: { id: 'Q2', model: 'm1', photos: [photo('File:x.jpg', [vec(9)])] },
};

let dir: string;
let galleryFile: string;
const TOKEN = 'secret-token';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pick-'));
  galleryFile = path.join(dir, 'gallery.json');
  const g: Gallery = {
    model: 'm1',
    people: [{ id: 'Q9', name: 'Other', aliases: [], refs: [vec(5), vec(5, 6, 0.1), vec(5, 7, 0.1)] }],
    excluded: [
      { id: 'Q1', refs: 1 },
      { id: 'Q2', refs: 0 },
      { id: 'Q3', refs: 2 },
    ],
  };
  await saveGallery(galleryFile, g);
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 80)); // let background prefetches finish writing
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

function makeApp(gather = async (p: KnownPerson) => CANDS[p.id]) {
  const store = createCandidateStore({ cacheDir: path.join(dir, 'cache'), gather });
  return createPickApp({
    token: TOKEN,
    people: PEOPLE,
    store,
    loadGallery: () => loadGallery(galleryFile),
    saveGallery: (g) => saveGallery(galleryFile, g),
  });
}

const req = (path: string, over: Partial<PickRequest> = {}): PickRequest => ({
  method: 'GET',
  path,
  query: new URLSearchParams(),
  headers: { host: '127.0.0.1:5000', 'x-pick-token': TOKEN },
  ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 50));
const body = (r: { body: string | Buffer }) => JSON.parse(r.body.toString());

describe('pick app', () => {
  it('requires the token (403 without or with a wrong one), in header or query', async () => {
    const app = makeApp();
    expect((await app.handle(req('/api/queue', { headers: { host: '127.0.0.1:5000' } }))).status).toBe(403);
    expect((await app.handle(req('/api/queue', { headers: { host: '127.0.0.1:5000', 'x-pick-token': 'nope' } }))).status).toBe(403);
    expect((await app.handle(req('/api/queue'))).status).toBe(200);
    expect((await app.handle(req('/api/queue', { headers: { host: 'localhost:1' }, query: new URLSearchParams({ token: TOKEN }) }))).status).toBe(200);
    expect((await app.handle(req('/', { headers: { host: 'evil.example:80', 'x-pick-token': TOKEN } }))).status).toBe(403);
  });

  it('validates person ids and face indexes', async () => {
    const app = makeApp();
    expect((await app.handle(req('/api/person/not-an-id'))).status).toBe(400);
    expect((await app.handle(req('/api/person/Q77'))).status).toBe(404);
    await app.handle(req('/api/person/Q1'));
    await settle();
    const post = (b: unknown) => app.handle(req('/api/person/Q1/suggest', { method: 'POST', body: b }));
    expect((await post({ picks: [{ photo: 0, face: 5 }] })).status).toBe(400);
    expect((await post({ picks: [{ photo: 9, face: 0 }] })).status).toBe(400);
    expect((await post({ picks: [{ photo: 0.5, face: 0 }] })).status).toBe(400);
    expect((await post({ picks: [{ photo: 0, face: 0 }, { photo: 0, face: 0 }] })).status).toBe(400);
    expect((await post({ picks: 'x' })).status).toBe(400);
    expect((await post({ picks: [{ photo: 0, face: 0 }] })).status).toBe(200);
    expect((await app.handle(req('/api/person/Q1/image/99'))).status).toBe(404);
  });

  it('preselects single faces, suggests (not preselects) the group face, serves images', async () => {
    const app = makeApp();
    await app.handle(req('/api/person/Q1'));
    await settle();
    const d = body(await app.handle(req('/api/person/Q1')));
    expect(d.status).toBe('ready');
    expect(d.preselected).toEqual([{ photo: 0, face: 0 }, { photo: 1, face: 0 }, { photo: 2, face: 0 }]);
    expect(d.suggestions).toHaveLength(1);
    expect(d.suggestions[0]).toMatchObject({ photo: 3, face: 1 });
    expect(d.photos[3].license).toBe('CC BY 4.0');
    const img = await app.handle(req('/api/person/Q1/image/0'));
    expect(img.contentType).toBe('image/jpeg');
    expect(img.body.toString()).toBe('img-File:a.jpg');
  });

  it('refuses to save with no picks and leaves the file alone', async () => {
    const app = makeApp();
    await app.handle(req('/api/person/Q1'));
    await settle();
    const before = await fs.readFile(galleryFile, 'utf8');
    const r = await app.handle(req('/api/person/Q1/save', { method: 'POST', body: { picks: [] } }));
    expect(r.status).toBe(400);
    expect(await fs.readFile(galleryFile, 'utf8')).toBe(before);
  });

  it('saves the chosen embeddings, clears only that exclusion, keeps other people intact', async () => {
    const app = makeApp();
    await app.handle(req('/api/person/Q1'));
    await settle();
    const picks = [{ photo: 3, face: 1 }, { photo: 0, face: 0 }, { photo: 1, face: 0 }];
    const r = await app.handle(req('/api/person/Q1/save', { method: 'POST', body: { picks } }));
    expect(r.status).toBe(200);
    const g = (await loadGallery(galleryFile))!;
    expect(g.people.map((p) => p.id)).toEqual(['Q9', 'Q1']);
    const q9 = g.people[0];
    expect(q9.refs).toHaveLength(3);
    expect(Array.from(q9.refs[1])).toEqual(Array.from(vec(5, 6, 0.1)));
    const q1 = g.people[1];
    expect(q1.name).toBe('Ada');
    expect(q1.aliases).toEqual(['A']);
    expect(q1.refs).toHaveLength(3);
    expect(Array.from(q1.refs[0])).toEqual(Array.from(CANDS.Q1.photos[3].faces[1].embedding));
    expect(Array.from(q1.refs[1])).toEqual(Array.from(CANDS.Q1.photos[0].faces[0].embedding));
    expect(g.excluded).toEqual([{ id: 'Q2', refs: 0 }, { id: 'Q3', refs: 2 }]);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(app.summary().saved).toEqual(['Q1']);
  });

  it('caps saved refs at MAX_REFS', async () => {
    const many: PersonCandidates = { id: 'Q1', model: 'm1', photos: Array.from({ length: 12 }, (_, i) => photo(`File:${i}.jpg`, [vec(0, i + 1, 0.05)])) };
    const app = makeApp(async () => many);
    await app.handle(req('/api/person/Q1'));
    await settle();
    const picks = many.photos.map((_, i) => ({ photo: i, face: 0 }));
    const r = await app.handle(req('/api/person/Q1/save', { method: 'POST', body: { picks } }));
    expect(body(r)).toMatchObject({ saved: 10, ignored: 2 });
    expect((await loadGallery(galleryFile))!.people.find((p) => p.id === 'Q1')!.refs).toHaveLength(10);
  });

  it('refuses a save when the candidates were made with another model', async () => {
    const app = makeApp(async () => ({ ...CANDS.Q1, model: 'other' }));
    await app.handle(req('/api/person/Q1'));
    await settle();
    const picks = [0, 1, 2].map((photo) => ({ photo, face: 0 }));
    expect((await app.handle(req('/api/person/Q1/save', { method: 'POST', body: { picks } }))).status).toBe(409);
  });

  it('skip does not touch the gallery', async () => {
    const app = makeApp();
    const before = await fs.readFile(galleryFile, 'utf8');
    expect((await app.handle(req('/api/person/Q2/skip', { method: 'POST' }))).status).toBe(200);
    expect(await fs.readFile(galleryFile, 'utf8')).toBe(before);
    expect(app.summary().skipped).toEqual(['Q2']);
  });
});

describe('scoring', () => {
  it('suggests the group face closest to the picks and warns on a pick unlike the others', () => {
    const c = CANDS.Q1;
    const s = suggest(c, [{ photo: 0, face: 0 }]);
    expect(s).toEqual([expect.objectContaining({ photo: 3, face: 1 })]);
    expect(suggest(c, [])).toEqual([]);
    const odd: PersonCandidates = {
      id: 'Q1',
      model: 'm1',
      photos: [photo('a', [vec(0)]), photo('b', [vec(0, 1, 0.1)]), photo('c', [vec(0, 2, 0.1)]), photo('d', [vec(50)])],
    };
    const low = lowCosinePicks(odd, [0, 1, 2, 3].map((p) => ({ photo: p, face: 0 })));
    expect(low.map((l) => l.photo)).toEqual([3]);
    expect(lowCosinePicks(odd, [{ photo: 0, face: 0 }, { photo: 3, face: 0 }])).toEqual([]);
  });
});

describe('candidate cache', () => {
  it('a restart reuses the cache without crawling again', async () => {
    let calls = 0;
    const gather = async (p: KnownPerson) => {
      calls++;
      return CANDS[p.id];
    };
    const cacheDir = path.join(dir, 'cache');
    const first = createCandidateStore({ cacheDir, gather });
    first.request(PEOPLE[0]);
    await settle();
    expect(calls).toBe(1);
    const second = createCandidateStore({ cacheDir, gather });
    second.request(PEOPLE[0]);
    await settle();
    expect(calls).toBe(1);
    const e = second.request(PEOPLE[0]);
    expect(e.status).toBe('ready');
    if (e.status === 'ready') {
      expect(e.candidates.photos[0].image.toString()).toBe('img-File:a.jpg');
      expect(Array.from(e.candidates.photos[3].faces[1].embedding)).toEqual(Array.from(CANDS.Q1.photos[3].faces[1].embedding));
    }
  });

  it('crawls people one at a time and reports a failure', async () => {
    let inFlight = 0;
    let max = 0;
    const store = createCandidateStore({
      cacheDir: path.join(dir, 'cache'),
      gather: async (p) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        if (p.id === 'Q2') throw new Error('boom');
        return CANDS[p.id];
      },
    });
    store.request(PEOPLE[0]);
    store.request(PEOPLE[1]);
    await new Promise((r) => setTimeout(r, 100));
    expect(max).toBe(1);
    expect(store.request(PEOPLE[1])).toEqual({ status: 'error', message: 'boom' });
  });
});

describe('gatherCandidates', () => {
  it('keeps open-licensed raster photos with faces, drops the rest', async () => {
    const wikimedia: any = {
      portrait: async () => 'File:p.jpg',
      categoryFiles: async () => ['File:p.jpg', 'File:q.png', 'File:r.svg', 'File:s.jpg'],
      fileInfos: async (titles: string[]) => new Map(titles.map((t) => [t, { thumbUrl: `u/${t}`, license: t === 'File:s.jpg' ? 'All rights reserved' : 'CC BY 4.0' }])),
      isOpenLicense: (l: string) => l.startsWith('CC'),
    };
    const sidecar: any = {
      model: async () => 'm1',
      detect: async (img: Buffer) => ({
        model: 'm1',
        width: 100,
        height: 50,
        faces: img.toString() === 'u/File:q.png' ? [] : [{ bbox: [1, 2, 3, 4], detScore: 0.9, embedding: b64(vec(0)) }],
      }),
    };
    const c = await gatherCandidates(PEOPLE[0], { wikimedia, sidecar, download: async (u) => Buffer.from(u) });
    expect(c.model).toBe('m1');
    expect(c.photos.map((p) => p.title)).toEqual(['File:p.jpg']);
    expect(c.photos[0].faces[0].bbox).toEqual([1, 2, 3, 4]);
  });
});

describe('server binding', () => {
  it('refuses any host but 127.0.0.1 and listens on 127.0.0.1', async () => {
    const app = makeApp();
    await expect(startPickServer(app, { token: TOKEN, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/);
    const s = await startPickServer(app, { token: TOKEN });
    try {
      expect(s.url.startsWith('http://127.0.0.1:')).toBe(true);
      expect((await fetch(s.url.split('?')[0] + 'api/queue')).status).toBe(403);
      const ok = await fetch(`http://127.0.0.1:${s.port}/api/queue`, { headers: { 'X-Pick-Token': TOKEN } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBeNull();
      const page = await fetch(s.url);
      expect(await page.text()).toContain('Known gallery picker');
    } finally {
      await s.close();
    }
  });
});
