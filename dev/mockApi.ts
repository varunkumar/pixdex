/**
 * Dev-only mock of the same-origin `/api/*` read API, for checking the UI in a real browser without the Worker.
 *
 *   PIXDEX_MOCK=1 npm run dev
 *
 * Enabled only by that env var (read in Node by vite.config.ts, never shown to the client bundle). With it on, the
 * dev server needs no `.env`: no WORKER_URL, READ_TOKEN or any other secret, and nothing reaches the real Worker,
 * D1 or R2. All names are fictional dummies and thumbnails are generated SVG landscapes (no real photos or people).
 * This file lives outside `src/` and is never imported by app code, so `npm run build` never contains it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type {
  AccessRequest,
  KnownPersonSummary,
  PersonSummary,
  SerializedFace,
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
  { id: 'own-arjun', name: 'Arjun Mehta', faceCount: 12, photoCount: 9, canEdit: true, cover: null },
  { id: 'own-meera', name: 'Meera Iyer', faceCount: 7, photoCount: 6, canEdit: true, cover: null },
  { id: 'own-unnamed', name: null, faceCount: 5, photoCount: 4, canEdit: true, cover: null },
];

const KNOWN: KnownPersonSummary[] = [
  { id: 'Q900001', name: 'Rohan Kapoor', aliases: ['RK', 'Rocky'], photoCount: 14 },
  { id: 'Q900002', name: 'Kabir Sen', aliases: ['KS', 'Kabbu'], photoCount: 11 },
  { id: 'Q900003', name: 'Tara Menon', aliases: ['Taru'], photoCount: 8 },
  { id: 'Q900004', name: 'Neel Varma', aliases: ['NV', 'Neelu'], photoCount: 6 },
  { id: 'Q900005', name: 'Ganesh Rao', aliases: ['Gani'], photoCount: 5 },
  { id: 'Q900006', name: 'Anika Shah', aliases: ['Ani'], photoCount: 4 },
  // Shares a name with the own person "Arjun Mehta".
  { id: 'Q900007', name: 'Arjun Mehta', aliases: [], photoCount: 3 },
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

/** Dummy unnamed faces (three groups); ignoring and restoring flips them until the dev server restarts. */
const FACE_GROUPS = [4, 2, 1];
const FACES: SerializedFace[] = FACE_GROUPS.flatMap((size, g) =>
  Array.from({ length: size }, (_, i) => ({
    id: `mock-face-${g}-${i}`,
    photoId: `mock-face-photo-${g}-${i}`,
    thumbnailUrl: `/thumbnails/mock-face-${g}-${i}`,
    cropUrl: null,
    bbox: { x: 0.25, y: 0.15, w: 0.5, h: 0.6 },
    detScore: 0.99,
    personId: null,
    personName: null,
    status: 'unassigned' as const,
    matchScore: null,
    ignored: false,
  })),
);

const NEXT_STATUS = { approve: 'approved', deny: 'denied', revoke: 'revoked' } as const;

/** Dummy species, keyed by scientific name (what `species=` filters on). */
const SPECIES = [
  { scientific: 'Panthera pardus', common: 'Leopard' },
  { scientific: 'Pavo cristatus', common: 'Indian Peafowl' },
  { scientific: 'Haliastur indus', common: 'Brahminy Kite' },
  { scientific: 'Axis axis', common: 'Chital' },
  { scientific: 'Alcedo atthis', common: 'Common Kingfisher' },
];

interface Theme {
  name: string;
  month: number;
  /** Gradient colours, top left to bottom right, and the hue of the soft sun. */
  from: string;
  to: string;
  subjects: string[];
  tags: string[];
  captions: string[];
  scene: string;
}
const THEMES: Theme[] = [
  {
    name: 'Savanna Sunrise (Jan 2026)',
    month: 1,
    from: '#f4a259',
    to: '#5b1f1a',
    subjects: ['Lion', 'African elephant', 'Giraffe', 'Zebra'],
    tags: ['savanna', 'wildlife', 'golden hour', 'telephoto'],
    captions: ['Between the trees', 'Morning mist', 'Golden hour', 'Long shadows'],
    scene: 'savanna',
  },
  {
    name: 'Misty Forest Trek',
    month: 2,
    from: '#72b896',
    to: '#0e2f2a',
    subjects: ['Red fox', 'Sambar deer', 'Great horned owl', 'Grey langur'],
    tags: ['forest', 'wildlife', 'mist', 'trail'],
    captions: ['First light on the trail', 'Under the canopy', 'Still morning', 'Fern and fog'],
    scene: 'misty forest',
  },
  {
    name: 'Coastal Weekend',
    month: 3,
    from: '#6ec1f5',
    to: '#14305a',
    subjects: ['Brown pelican', 'Sea gull', 'Ghost crab', 'Fishing boat'],
    tags: ['beach', 'coast', 'sea', 'sunny'],
    captions: ['Low tide', 'Salt wind', 'Pier at noon', 'Waves and wings'],
    scene: 'coast',
  },
  {
    name: 'Family Reunion',
    month: 4,
    from: '#dc86b4',
    to: '#3a1f55',
    subjects: ['Person', 'Birthday cake', 'Children playing', 'Group photo'],
    tags: ['family', 'celebration', 'indoor', 'portrait'],
    captions: ['Everyone together', 'Cake time', 'Garden games', 'Cousins'],
    scene: 'garden',
  },
];
// More albums so the albums page has several pages of whole rows (the first four are the README ones).
const MORE: [string, number, string, string, string[], string[], string][] = [
  ['Mountain Weekend', 5, '#8fb8de', '#1f3552', ['Pine marten', 'Himalayan monal', 'Hiker'], ['mountain', 'trail', 'clouds', 'hiking'], 'mountain'],
  ['Birthday Party', 5, '#f2b36d', '#5a2a3c', ['Birthday cake', 'Balloons', 'Children playing'], ['family', 'celebration', 'indoor', 'candles'], 'living room'],
  ['Temple Visit', 6, '#e6c27a', '#4a2a14', ['Temple gopuram', 'Lamp', 'Devotee'], ['temple', 'architecture', 'festival', 'stone'], 'temple courtyard'],
  ['Backwater Boat Ride', 6, '#7fc9c0', '#15404a', ['Kingfisher', 'Houseboat', 'Egret'], ['backwaters', 'boat', 'calm', 'palm'], 'backwaters'],
  ['Summer Camp', 7, '#a7d676', '#26441e', ['Campfire', 'Tent', 'Children playing'], ['camp', 'outdoor', 'friends', 'summer'], 'campsite'],
  ['Diwali Lights', 11, '#f0a15c', '#3b1a3f', ['Diya', 'Rangoli', 'Sparkler'], ['festival', 'lights', 'night', 'family'], 'courtyard'],
  ['Rainy Season', 8, '#9db4c9', '#1f2d3d', ['Peacock', 'Umbrella', 'Frog'], ['rain', 'monsoon', 'green', 'puddle'], 'garden'],
  ['School Annual Day', 12, '#c99ae0', '#2c1a4f', ['Stage', 'Dancer', 'Group photo'], ['school', 'stage', 'costume', 'event'], 'auditorium'],
  ['Bandipur Safari', 9, '#d9b36b', '#3a2c12', ['Tiger', 'Spotted deer', 'Gaur'], ['safari', 'wildlife', 'jungle', 'jeep'], 'dry forest'],
  ['Hampi Ruins', 10, '#e8b27c', '#4a2a1c', ['Stone chariot', 'Boulders', 'Monkey'], ['ruins', 'heritage', 'boulders', 'sunset'], 'ruins'],
  ['Wedding Weekend', 12, '#f4a6b8', '#4a1f3a', ['Bride and groom', 'Mehendi', 'Group photo'], ['wedding', 'celebration', 'ceremony', 'family'], 'wedding hall'],
  ['Tea Estate Trek', 3, '#9ccf95', '#143a25', ['Tea pickers', 'Mist', 'Hornbill'], ['tea', 'hills', 'mist', 'trail'], 'tea estate'],
  ['Beach Bonfire', 4, '#f5a56a', '#1b2a52', ['Bonfire', 'Friends', 'Crab'], ['beach', 'night', 'friends', 'waves'], 'beach'],
  ['New Year Eve', 12, '#8e8be6', '#161a3f', ['Fireworks', 'Friends', 'Cake'], ['party', 'night', 'celebration', 'lights'], 'rooftop'],
];
for (const [name, month, from, to, subjects, tags, scene] of MORE) {
  THEMES.push({
    name,
    month,
    from,
    to,
    subjects,
    tags,
    scene,
    captions: ['Golden light', 'Together', 'Quiet moment', 'Just after sunrise'],
  });
}
const ALBUMS = THEMES.map((t) => t.name);

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
  for (let i = 0; i < 270; i++) {
    const people = OWN.filter(() => rand() < 0.22).map((p) => p.id);
    const known = KNOWN.filter(() => rand() < 0.15).map((k) => k.id);
    const theme = THEMES[i % THEMES.length];
    const subject = pick(theme.subjects);
    // Most photos sit in the album's own month of 2026, the rest are older, so the timeline has some spread.
    const recent = rand() < 0.75;
    const year = recent ? 2026 : 2018 + Math.floor(rand() * 8);
    const month = recent ? theme.month : 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dated = rand() > 0.08;
    const tags = [subject.toLowerCase(), pick(theme.tags), pick(theme.tags)].filter((t, k, a) => a.indexOf(t) === k);
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
        filename: `IMG_${String(i + 1000).padStart(4, '0')}.jpg`,
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
        album: theme.name,
        description: `A ${subject.toLowerCase()} in the ${theme.scene}, softly lit, with a clean out-of-focus background.`,
        suggestedHashtags: [],
        instagramSuggested: null,
        thumbnailUrl: `/thumbnails/${id}`,
        shortCaption: theme.captions[Math.floor(i / THEMES.length) % theme.captions.length],
        aestheticScore: 1 + ((i * 3 + Math.floor(i / 4)) % 10),
        combinedScore: 1 + ((i * 3 + Math.floor(i / 4)) % 10),
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

/** A themed placeholder in the photo's own shape: album colours, a soft sun, a dark hill and the subject as a label. */
function thumbnailSvg(id: string, longSide?: number): string {
  const index = Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  const { width: w, height: ht } = mockSize(index);
  const photo = LIBRARY.find((m) => m.photo.id === id)?.photo;
  const theme = THEMES.find((t) => t.name === photo?.album) ?? THEMES[index % THEMES.length];
  const label = photo ? (photo.subjects[0] ?? '') : '';
  const subject = label ? label[0].toUpperCase() + label.slice(1) : '';
  const W = 400;
  const H = Math.round((W * ht) / w);
  // Sun position and hill shape vary a little per photo, deterministically.
  const sx = 0.2 + ((index * 37) % 60) / 100;
  const sy = 0.2 + ((index * 17) % 25) / 100;
  const hill = H * (0.78 + ((index * 7) % 8) / 100);
  // The same drawing at a larger rendered size (album heroes).
  const scale = longSide ? longSide / Math.max(W, H) : 1;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${theme.from}"/><stop offset="1" stop-color="${theme.to}"/></linearGradient>` +
    `<radialGradient id="s"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#g)"/>` +
    `<circle cx="${Math.round(W * sx)}" cy="${Math.round(H * sy)}" r="${Math.round(Math.min(W, H) * 0.17)}" fill="url(#s)"/>` +
    `<path d="M0,${hill} C${W * 0.3},${hill - H * 0.08} ${W * 0.6},${hill + H * 0.06} ${W},${hill - H * 0.03} L${W},${H} L0,${H} Z" fill="#000" fill-opacity="0.32"/>` +
    (subject
      ? `<text x="${W / 2}" y="${H - 12}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#fff" fill-opacity="0.75">${subject}</text>`
      : '') +
    `</svg>`
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
  const flip = /^\/faces\/(ignore|restore)$/.exec(path);
  if (method === 'POST' && flip) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const ids = new Set((JSON.parse(raw || '{}') as { faceIds?: string[] }).faceIds ?? []);
      const ignored = flip[1] === 'ignore';
      const changed = FACES.filter((f) => ids.has(f.id) && f.ignored !== ignored);
      for (const f of changed) f.ignored = ignored;
      sendJson(res, 200, ignored ? { ignored: changed.length } : { restored: changed.length });
    });
    return true;
  }
  if (method !== 'GET') return sendJson(res, 405, { error: 'The dev mock is read-only apart from admin decisions and ignoring faces' });
  if (path === '/me') return sendJson(res, 200, { email: EMAIL, admin: true });
  if (path === '/admin/requests') {
    const wanted = url.searchParams.get('status');
    const pendingCount = REQUESTS.filter((r) => r.status === 'pending').length;
    const requests = REQUESTS.filter((r) => !wanted || r.status === wanted).sort((a, b) => b.id - a.id);
    return sendJson(res, 200, { requests, pendingCount, queueFull: pendingCount >= 3 });
  }
  if (path === '/people') return sendJson(res, 200, { people: OWN });
  if (path === '/people/known') return sendJson(res, 200, { known: KNOWN });
  if (path === '/people/groups') {
    const groups = FACE_GROUPS.map((_, g) => ({ faces: FACES.filter((f) => !f.ignored && f.id.startsWith(`mock-face-${g}-`)) })).filter(
      (g) => g.faces.length > 0,
    );
    return sendJson(res, 200, { groups, scanned: groups.reduce((n, g) => n + g.faces.length, 0), nextCursor: null });
  }
  if (path === '/people/ignored') return sendJson(res, 200, { faces: FACES.filter((f) => f.ignored), nextCursor: null });
  if (path === '/albums' && !url.searchParams.has('limit')) return sendJson(res, 200, { albums: ALBUMS });
  if (path === '/albums') {
    const albums = ALBUMS.map((name, i) => {
      // The cover is the newest dated photo (undated last), so the card date matches the album name.
      const photos = LIBRARY.filter((m) => m.photo.album === name)
        .map((m) => m.photo)
        .sort((x, y) => (y.dateTime ?? '').localeCompare(x.dateTime ?? ''));
      return {
        name,
        photoCount: photos.length,
        coverPhotoId: photos[0].id,
        coverThumbnailUrl: photos[0].thumbnailUrl ?? null,
        latestDate: photos[0].dateTime,
        // One shared-out album (avatar stack with +N) and one shared-with-you album, to show both states.
        ...(i === 2
          ? { role: 'viewer' as const, ownerEmail: 'priya.nair@example.com' }
          : {
              role: 'owner' as const,
              sharedWith: i === 0 ? ['asha.rao@example.com', 'ravi.menon@example.com', 'meera.iyer@example.com', 'nikhil.s@example.com'] : [],
            }),
      };
    });
    // Same paging as the Worker: an optional `name`, then `limit` and `offset`.
    const named = url.searchParams.get('name');
    const matching = named ? albums.filter((a) => a.name === named) : albums;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 12, 1), 48);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    return sendJson(res, 200, { albums: matching.slice(offset, offset + limit), total: albums.length });
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
  // A hero is always "already made" here (a mock photo's content hash is its id), so the mock never gets an upload.
  const isHero = path.startsWith('/heroes/');
  if (isHero || path.startsWith('/thumbnails/') || path.startsWith('/originals/')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.end(thumbnailSvg(decodeURIComponent(path.split('/').pop() ?? ''), isHero ? 2048 : undefined));
    return true;
  }
  const photo = /^\/photos\/([^/]+)$/.exec(path);
  if (photo) {
    const found = LIBRARY.find((m) => m.photo.id === decodeURIComponent(photo[1]));
    if (found) return sendJson(res, 200, found.photo);
  }
  const photoFaces = /^\/photos\/([^/]+)\/faces$/.exec(path);
  if (photoFaces) {
    // Every library photo shows the first two dummy faces, so the photo page controls can be tried.
    const own = FACES.filter((f) => f.photoId === decodeURIComponent(photoFaces[1]));
    return sendJson(res, 200, { faces: own.length ? own : FACES.slice(0, 2) });
  }
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
