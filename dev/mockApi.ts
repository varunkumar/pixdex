/**
 * Dev-only mock of the same-origin `/api/*` read API, for checking the UI in a real browser without the Worker.
 *
 *   PIXDEX_MOCK=1 npm run dev
 *
 * Enabled only by that env var (read in Node by vite.config.ts, never shown to the client bundle). With it on, the
 * dev server needs no `.env`: no WORKER_URL, READ_TOKEN or any other secret, and nothing reaches the real Worker,
 * D1 or R2. All names are fictional dummies and thumbnails are generated SVG gradients (no real photos or people).
 * This file lives outside `src/` and is never imported by app code, so `npm run build` never contains it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type {
  AccessRequest,
  KnownPersonSummary,
  PersonSummary,
  SerializedPhoto,
} from '../src/types/api.ts';

/** Dummy photo shapes (portrait, square, 4:3, 3:2, panorama) so the masonry grid has something to lay out. */
const MOCK_SIZES: [number, number][] = [
  [1600, 1067],
  [1067, 1600],
  [1600, 1600],
  [1600, 1200],
  [1200, 1600],
  [2400, 1000],
  [1600, 1067],
];
function mockSize(i: number): { width: number; height: number } {
  const [width, height] = MOCK_SIZES[i % MOCK_SIZES.length];
  return { width, height };
}

const EMAIL = 'demo.viewer@example.com';

const OWN: PersonSummary[] = [
  { id: 'own-asha', name: 'Asha Rao', faceCount: 40, photoCount: 31, canEdit: true, cover: null },
  { id: 'own-ravi', name: 'Ravi Menon', faceCount: 22, photoCount: 18, canEdit: true, cover: null },
  { id: 'own-dhoni', name: 'Demo Dhoni', faceCount: 12, photoCount: 9, canEdit: true, cover: null },
  { id: 'own-meera', name: 'Meera Demo', faceCount: 7, photoCount: 6, canEdit: true, cover: null },
  { id: 'own-unnamed', name: null, faceCount: 5, photoCount: 4, canEdit: true, cover: null },
];

const KNOWN: KnownPersonSummary[] = [
  { id: 'Q900001', name: 'Mahendra Demo Dhoni', aliases: ['MDD', 'Mahi Demo'], photoCount: 14 },
  { id: 'Q900002', name: 'Virat Demo Kohli', aliases: ['VDK', 'Cheeku Demo'], photoCount: 11 },
  { id: 'Q900003', name: 'Sachin Demo', aliases: ['Little Demo Master'], photoCount: 8 },
  { id: 'Q900004', name: 'Shah Rukh Demo', aliases: ['SRD', 'King Demo'], photoCount: 6 },
  { id: 'Q900005', name: 'Ganesh Demo', aliases: ['Ganpati Demo'], photoCount: 5 },
  { id: 'Q900006', name: 'Rahman Demo', aliases: ['Mozart Demo'], photoCount: 4 },
  // Shares a name with the own person "Demo Dhoni".
  { id: 'Q900007', name: 'Demo Dhoni', aliases: [], photoCount: 3 },
];

/** In-memory access requests for the admin page demo; decisions move rows between tabs until the dev server restarts. */
const REQUESTS: AccessRequest[] = [
  { id: 1, email: 'priya.demo@example.com', note: 'Friend of the family, would love to see the Kabini photos.', status: 'pending', createdAt: '2026-11-14T09:30:00Z', decidedAt: null },
  { id: 2, email: 'a-very-long-demo-address-for-layout-checks@subdomain.example.com', note: 'x'.repeat(200), status: 'pending', createdAt: '2026-11-13T18:05:00Z', decidedAt: null },
  { id: 3, email: 'rohan.demo@example.com', note: null, status: 'pending', createdAt: '2026-11-12T07:10:00Z', decidedAt: null },
  { id: 4, email: 'meera.demo@example.com', note: '<b>not bold</b> & friends', status: 'approved', createdAt: '2026-11-08T11:00:00Z', decidedAt: '2026-11-09T10:00:00Z' },
  { id: 5, email: 'spam.demo@example.com', note: 'buy now', status: 'denied', createdAt: '2026-11-07T11:00:00Z', decidedAt: '2026-11-07T12:00:00Z' },
  { id: 6, email: 'old.demo@example.com', note: null, status: 'revoked', createdAt: '2026-10-01T11:00:00Z', decidedAt: '2026-11-01T12:00:00Z' },
];

const NEXT_STATUS = { approve: 'approved', deny: 'denied', revoke: 'revoked' } as const;

/** Dummy species, keyed by scientific name (what `species=` filters on). */
const SPECIES = [
  { scientific: 'Panthera pardus', common: 'Leopard' },
  { scientific: 'Pavo cristatus', common: 'Indian Peafowl' },
  { scientific: 'Haliastur indus', common: 'Brahminy Kite' },
  { scientific: 'Axis axis', common: 'Chital' },
  { scientific: 'Alcedo atthis', common: 'Common Kingfisher' },
];

const ALBUMS = ['Kabini Demo', 'Goa Demo Trip', 'Cricket Demo Day', 'Family Demo'];
const TAGS = ['beach', 'cricket', 'sunset', 'temple', 'forest', 'birthday', 'leopard', 'street'];

/** Small deterministic PRNG so the dummy library is identical on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface MockPhoto {
  species: string[];
  photo: SerializedPhoto;
  people: string[];
  known: string[];
}

function buildLibrary(): MockPhoto[] {
  const rand = rng(42);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const out: MockPhoto[] = [];
  for (let i = 0; i < 120; i++) {
    const people = OWN.filter(() => rand() < 0.22).map((p) => p.id);
    const known = KNOWN.filter(() => rand() < 0.15).map((k) => k.id);
    const year = 2018 + Math.floor(rand() * 8);
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dated = rand() > 0.08;
    const tags = [pick(TAGS), pick(TAGS)];
    const id = `mock-${pad(i)}`;
    out.push({
      people,
      known,
      species: SPECIES.filter((_, k) => (i + k) % 9 === 0).map((s) => s.scientific),
      photo: {
        id,
        canEdit: true,
        path: null,
        driveFileId: null,
        source: 'local',
        filename: `DEMO_${String(i).padStart(4, '0')}.jpg`,
        dateTime: dated ? `${year}-${pad(month)}-${pad(day)}T10:00:00` : null,
        ...mockSize(i),
        format: 'jpeg',
        fileSize: 1_000_000,
        subjects: tags,
        colors: [],
        patterns: [],
        tags,
        season: null,
        environment: null,
        album: pick(ALBUMS),
        description: `Dummy placeholder photo ${i} with ${tags.join(' and ')}.`,
        suggestedHashtags: [],
        instagramSuggested: null,
        thumbnailUrl: `/thumbnails/${id}`,
        shortCaption: `Demo ${tags[0]} ${i}`,
        aestheticScore: 1 + (i % 10),
        combinedScore: 1 + (i % 10),
      },
    });
  }
  return out;
}

const LIBRARY = buildLibrary();
// photoCount matches the dummy library, so a list count and a search total agree.
for (const p of OWN) p.photoCount = LIBRARY.filter((m) => m.people.includes(p.id)).length;
for (const k of KNOWN) k.photoCount = LIBRARY.filter((m) => m.known.includes(k.id)).length;

function list(v: string | null): string[] {
  return v ? v.split(',').filter(Boolean) : [];
}

function search(params: URLSearchParams): { results: SerializedPhoto[]; total: number } {
  const q = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const album = params.get('album');
  const people = list(params.get('people'));
  const known = list(params.get('known'));
  const species = params.get('species');
  const from = params.get('from');
  const to = params.get('to');
  const onThisDay = params.get('onThisDay');
  const limit = Math.min(100, Math.max(1, Number(params.get('limit') ?? 30) || 30));
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
  const sort = params.get('sort') ?? 'date';

  const matched = LIBRARY.filter((m) => {
    const p = m.photo;
    const date = p.dateTime?.slice(0, 10) ?? null;
    if (album && p.album !== album) return false;
    if (!people.every((id) => m.people.includes(id))) return false;
    if (!known.every((id) => m.known.includes(id))) return false;
    if (species && !m.species.includes(species)) return false;
    if (from && (!date || date < from)) return false;
    if (to && (!date || date > to)) return false;
    if (onThisDay && (!date || date.slice(5) !== onThisDay)) return false;
    const text = `${p.description} ${p.tags.join(' ')} ${p.album}`.toLowerCase();
    return q.every((w) => text.includes(w));
  }).map((m) => m.photo);

  const sorted = [...matched].sort((a, b) => {
    if (sort === 'name') return (a.filename ?? '').localeCompare(b.filename ?? '');
    if (sort === 'rating') return (b.combinedScore ?? 0) - (a.combinedScore ?? 0);
    return (b.dateTime ?? '').localeCompare(a.dateTime ?? '');
  });
  return { results: sorted.slice(offset, offset + limit), total: matched.length };
}

/** A gradient placeholder in the photo's own shape, hue derived from the id. */
function thumbnailSvg(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const index = Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  const { width: w, height: ht } = mockSize(index);
  const W = 400;
  const H = Math.round((W * ht) / w);
  const h2 = (h + 60) % 360;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h},65%,55%)"/><stop offset="1" stop-color="hsl(${h2},65%,35%)"/>` +
    `</linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
  return true;
}

/** Answers one `/api/*` request; returns false only for paths outside `/api`. */
export function handleMock(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://mock.local');
  if (!url.pathname.startsWith('/api/')) return false;
  const path = url.pathname.slice('/api'.length);
  const method = req.method ?? 'GET';

  const decision = /^\/admin\/requests\/(\d+)\/(approve|deny|revoke)$/.exec(path);
  if (method === 'POST' && decision) {
    const found = REQUESTS.find((r) => r.id === Number(decision[1]));
    if (!found) return sendJson(res, 404, { error: 'Not found' });
    found.status = NEXT_STATUS[decision[2] as keyof typeof NEXT_STATUS];
    found.decidedAt = new Date().toISOString();
    return sendJson(res, 200, { request: found });
  }
  if (method !== 'GET') return sendJson(res, 405, { error: 'The dev mock is read-only apart from admin decisions' });
  if (path === '/me') return sendJson(res, 200, { email: EMAIL, admin: true });
  if (path === '/admin/requests') {
    const wanted = url.searchParams.get('status');
    const pendingCount = REQUESTS.filter((r) => r.status === 'pending').length;
    const requests = REQUESTS.filter((r) => !wanted || r.status === wanted).sort((a, b) => b.id - a.id);
    return sendJson(res, 200, { requests, pendingCount, queueFull: pendingCount >= 3 });
  }
  if (path === '/people') return sendJson(res, 200, { people: OWN });
  if (path === '/people/known') return sendJson(res, 200, { known: KNOWN });
  if (path === '/people/groups') return sendJson(res, 200, { groups: [], scanned: 0, nextCursor: null });
  if (path === '/albums' && !url.searchParams.has('limit')) return sendJson(res, 200, { albums: ALBUMS });
  if (path === '/albums') {
    const albums = ALBUMS.map((name) => {
      const photos = LIBRARY.filter((m) => m.photo.album === name).map((m) => m.photo);
      return {
        name,
        photoCount: photos.length,
        coverPhotoId: photos[0].id,
        coverThumbnailUrl: photos[0].thumbnailUrl ?? null,
        latestDate: photos[0].dateTime,
        role: 'owner' as const,
        sharedWith: [],
      };
    });
    return sendJson(res, 200, { albums, total: albums.length });
  }
  if (path === '/albums/contents') {
    const inAlbum = LIBRARY.filter((m) => m.photo.album === url.searchParams.get('name'));
    const count = (has: (m: MockPhoto) => boolean) => inAlbum.filter(has).length;
    const face = (id: string, name: string | null, status: 'confirmed' | 'unassigned', has: (m: MockPhoto) => boolean) => {
      const m = inAlbum.find(has);
      if (!m) return null;
      return {
        id: `cover-${id}`,
        photoId: m.photo.id,
        thumbnailUrl: `/thumbnails/${m.photo.id}`,
        cropUrl: null,
        bbox: { x: 0.3, y: 0.2, w: 0.3, h: 0.3 },
        detScore: 0.99,
        personId: status === 'confirmed' ? id : null,
        personName: name,
        status,
        matchScore: null,
      };
    };
    const people = OWN.slice(0, 3)
      .map((p) => ({ id: p.id, name: p.name, canEdit: true, photoCount: count((m) => m.people.includes(p.id)), cover: face(p.id, p.name, 'confirmed', (m) => m.people.includes(p.id)) }))
      .filter((p) => p.photoCount > 0);
    const known = KNOWN.slice(0, 1)
      .map((k) => ({ id: k.id, name: k.name, photoCount: count((m) => m.known.includes(k.id)), cover: face(k.id, null, 'unassigned', (m) => m.known.includes(k.id)) }))
      .filter((k) => k.photoCount > 0);
    const species = SPECIES.flatMap((s) => {
      const first = inAlbum.find((m) => m.species.includes(s.scientific));
      if (!first) return [];
      return [{ ...s, photoCount: count((m) => m.species.includes(s.scientific)), coverPhotoId: first.photo.id, thumbnailUrl: `/thumbnails/${first.photo.id}` }];
    });
    return sendJson(res, 200, { people, known, species });
  }
  if (path === '/search') return sendJson(res, 200, search(url.searchParams));
  if (path === '/timeline') return sendJson(res, 200, { groups: [], nextCursor: null });
  if (path === '/timeline/buckets') return sendJson(res, 200, { buckets: [], undated: 0 });
  if (path.startsWith('/thumbnails/') || path.startsWith('/originals/')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.end(thumbnailSvg(decodeURIComponent(path.split('/').pop() ?? '')));
    return true;
  }
  const photo = /^\/photos\/([^/]+)$/.exec(path);
  if (photo) {
    const found = LIBRARY.find((m) => m.photo.id === decodeURIComponent(photo[1]));
    if (found) return sendJson(res, 200, found.photo);
  }
  if (/^\/photos\/[^/]+\/faces$/.test(path)) return sendJson(res, 200, { faces: [] });
  // Anything else is a clear 404 from the mock, never a fall-through to the real proxy.
  return sendJson(res, 404, { error: `Not mocked: ${path}` });
}

/** Vite plugin: registers the mock directly in configureServer, so it runs before Vite's own `/api` proxy. */
export function mockApiPlugin(): Plugin {
  return {
    name: 'pixdex-mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!handleMock(req, res)) next();
      });
      server.config.logger.info('  PixdeX mock API enabled (PIXDEX_MOCK=1): /api/* answered with dummy data');
    },
  };
}
