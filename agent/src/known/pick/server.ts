import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_REFS } from '../buildGallery';
import type { Gallery, GalleryPerson, KnownPerson } from '../gallery';
import { isQid, type CandidateStore } from './candidates';
import { PAGE_HTML } from './page';
import { lowCosinePicks, preselected, suggest, type FaceRef } from './scoring';

export const BIND_HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
const MAX_PICKS = 200;
/** Human-verified picks need fewer refs than the automatic build (3), down to a single photo: the owner has checked every face. */
export const MANUAL_MIN_PICKS = 1;

export interface PickRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body, or undefined. */
  body?: unknown;
}

export interface PickResponse {
  status: number;
  contentType: string;
  body: string | Buffer;
}

export interface PickAppDeps {
  token: string;
  /** People to work through, in order (already filtered to the excluded ones or the --id ones). */
  people: KnownPerson[];
  store: CandidateStore;
  loadGallery: () => Promise<Gallery | undefined>;
  saveGallery: (g: Gallery) => Promise<void>;
  onDone?: () => void;
}

const json = (status: number, value: unknown): PickResponse => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(value),
});
const err = (status: number, message: string) => json(status, { error: message });

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Parses `[{photo, face}, ...]`: integers only, bounded count, in range, no duplicates. Returns an error string on failure. */
export function parsePicks(raw: unknown, photos: { faces: unknown[] }[]): FaceRef[] | string {
  if (!Array.isArray(raw) || raw.length > MAX_PICKS) return 'picks must be an array of at most 200 entries';
  const seen = new Set<string>();
  const out: FaceRef[] = [];
  for (const r of raw) {
    const photo = (r as { photo?: unknown })?.photo;
    const face = (r as { face?: unknown })?.face;
    if (!Number.isInteger(photo) || !Number.isInteger(face)) return 'photo and face must be integers';
    const p = photo as number;
    const f = face as number;
    if (p < 0 || p >= photos.length) return `photo ${p} is out of range`;
    if (f < 0 || f >= photos[p].faces.length) return `face ${f} is out of range for photo ${p}`;
    const key = `${p}:${f}`;
    if (seen.has(key)) return 'duplicate pick';
    seen.add(key);
    out.push({ photo: p, face: f });
  }
  return out;
}

export function createPickApp(deps: PickAppDeps) {
  const done = new Map<string, 'saved' | 'skipped'>();
  const byId = new Map(deps.people.map((p) => [p.id, p]));
  let saving: Promise<unknown> = Promise.resolve();

  const nextAfter = (id: string): KnownPerson | undefined => {
    const i = deps.people.findIndex((p) => p.id === id);
    return deps.people.slice(i + 1).find((p) => !done.has(p.id));
  };

  async function save(person: KnownPerson, req: PickRequest): Promise<PickResponse> {
    const entry = deps.store.request(person);
    if (entry.status !== 'ready') return err(409, 'candidates are not loaded yet');
    const c = entry.candidates;
    const picks = parsePicks((req.body as { picks?: unknown } | undefined)?.picks, c.photos);
    if (typeof picks === 'string') return err(400, picks);
    if (picks.length < MANUAL_MIN_PICKS) return err(400, `Pick at least ${MANUAL_MIN_PICKS} faces (you have ${picks.length})`);
    const used = picks.slice(0, MAX_REFS);
    const result = saving.then(async () => {
      const gallery = await deps.loadGallery();
      if (!gallery) return err(409, 'no gallery file; run build-known-gallery first');
      if (gallery.model !== c.model) return err(409, `gallery model ${gallery.model} differs from the candidates' model ${c.model}`);
      const entryPerson: GalleryPerson = {
        id: person.id,
        name: person.name,
        aliases: person.aliases,
        refs: used.map((r) => c.photos[r.photo].faces[r.face].embedding),
      };
      const next: Gallery = {
        model: gallery.model,
        people: [...gallery.people.filter((p) => p.id !== person.id), entryPerson],
        ...((gallery.excluded ?? []).some((e) => e.id !== person.id)
          ? { excluded: (gallery.excluded ?? []).filter((e) => e.id !== person.id) }
          : {}),
      };
      await deps.saveGallery(next);
      done.set(person.id, 'saved');
      return json(200, { saved: used.length, ignored: picks.length - used.length });
    });
    saving = result.catch(() => undefined);
    return result;
  }

  async function handle(req: PickRequest): Promise<PickResponse> {
    const host = req.headers['host'];
    if (!host || !/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(host)) return err(403, 'bad host');
    const token = req.headers['x-pick-token'] ?? req.query.get('token') ?? undefined;
    if (!tokenOk(token, deps.token)) return err(403, 'forbidden');

    const method = req.method.toUpperCase();
    const segs = req.path.split('/').filter(Boolean);
    try {
      if (method === 'GET' && segs.length === 0) {
        return { status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML };
      }
      if (segs[0] !== 'api') return err(404, 'not found');

      if (method === 'GET' && segs[1] === 'queue' && segs.length === 2) {
        const first = deps.people.find((p) => !done.has(p.id));
        if (first) deps.store.request(first);
        return json(200, {
          min: MANUAL_MIN_PICKS,
          max: MAX_REFS,
          people: deps.people.map((p) => ({ ...p, state: done.get(p.id) ?? 'pending' })),
        });
      }
      if (method === 'POST' && segs[1] === 'done' && segs.length === 2) {
        deps.onDone?.();
        return json(200, { ok: true });
      }
      if (segs[1] !== 'person' || segs.length < 3) return err(404, 'not found');
      const id = segs[2];
      if (!isQid(id)) return err(400, 'invalid person id');
      const person = byId.get(id);
      if (!person) return err(404, 'unknown person');
      const action = segs[3];

      if (method === 'GET' && !action) {
        const entry = deps.store.request(person);
        const next = nextAfter(id);
        if (next && entry.status === 'ready') deps.store.request(next); // prefetch, queued behind the current crawl
        if (entry.status === 'loading') return json(200, { status: 'loading' });
        if (entry.status === 'error') return json(200, { status: 'error', message: entry.message });
        const c = entry.candidates;
        const pre = preselected(c);
        return json(200, {
          status: 'ready',
          person,
          preselected: pre,
          photos: c.photos.map((p) => ({
            title: p.title,
            license: p.license,
            width: p.width,
            height: p.height,
            faces: p.faces.map((f) => ({ bbox: f.bbox, score: f.detScore })),
          })),
          ...(() => {
            const s = suggest(c, pre);
            return { suggestions: s, warnings: lowCosinePicks(c, pre) };
          })(),
        });
      }
      if (method === 'POST' && action === 'retry') {
        deps.store.retry(id);
        deps.store.request(person);
        return json(200, { ok: true });
      }
      if (method === 'GET' && action === 'image' && segs.length === 5) {
        const entry = deps.store.request(person);
        if (entry.status !== 'ready') return err(409, 'not loaded');
        const n = Number(segs[4]);
        if (!/^\d{1,3}$/.test(segs[4]) || n >= entry.candidates.photos.length) return err(404, 'no such photo');
        const p = entry.candidates.photos[n];
        return { status: 200, contentType: p.contentType, body: p.image };
      }
      if (method === 'POST' && action === 'suggest') {
        const entry = deps.store.request(person);
        if (entry.status !== 'ready') return err(409, 'not loaded');
        const picks = parsePicks((req.body as { picks?: unknown } | undefined)?.picks, entry.candidates.photos);
        if (typeof picks === 'string') return err(400, picks);
        return json(200, { suggestions: suggest(entry.candidates, picks), warnings: lowCosinePicks(entry.candidates, picks) });
      }
      if (method === 'POST' && action === 'save') return await save(person, req);
      if (method === 'POST' && action === 'skip') {
        done.set(id, 'skipped');
        return json(200, { ok: true });
      }
      return err(404, 'not found');
    } catch (e) {
      return err(500, e instanceof Error ? e.message : 'error');
    }
  }

  return { handle, summary: () => ({ saved: [...done].filter(([, s]) => s === 'saved').map(([id]) => id), skipped: [...done].filter(([, s]) => s === 'skipped').map(([id]) => id) }) };
}

export interface RunningPickServer {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

/** Binds to 127.0.0.1 only. The `host` parameter exists so a test can assert anything else is refused. */
export async function startPickServer(
  app: { handle: (r: PickRequest) => Promise<PickResponse> },
  opts: { token: string; port?: number; host?: string }
): Promise<RunningPickServer> {
  const host = opts.host ?? BIND_HOST;
  if (host !== BIND_HOST) throw new Error(`the picker only binds to ${BIND_HOST}`);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', async () => {
      if (aborted) return;
      let body: unknown;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid JSON"}');
          return;
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const out = await app.handle({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers, body });
      res.writeHead(out.status, {
        'Content-Type': out.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, BIND_HOST, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${BIND_HOST}:${port}/?token=${opts.token}`,
    port,
    token: opts.token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const newToken = () => crypto.randomBytes(24).toString('hex');
