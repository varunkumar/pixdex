// Public enroll endpoint: POST /api/enroll. Together with /enroll (functions/enroll.ts) this is the only
// route of the app outside Cloudflare Access (an Access Bypass application covers exactly these two paths),
// so every input is treated as hostile and there is no Access JWT check here.
//
// Order: method, config, body size cap, JSON parse, shape check, Turnstile, then one Worker call. Nothing
// is fetched before the body passes the shape check, and the Worker is never called unless Turnstile
// confirms the token. The Worker (POST /enroll, READ_TOKEN bearer only) rate-limits by X-Client-IP and
// answers 202 {"ok":true} for every valid body, so a response never reveals whether an email is known.
//
// Routing: Pages sorts routes by specificity, so /api/enroll (this file) wins over /api/[[path]] for every
// method. A file that exported only onRequestPost would let GET, PUT, PATCH and DELETE fall through to the
// authenticated proxy (which answers 401 or 404, never forwarding enroll). `onRequest` below answers them
// with 405 here instead, so this path never reaches the proxy at all.

import { MAX_TOKEN_LENGTH, verifyTurnstile } from '../_lib/turnstile';

interface Env {
  WORKER_URL?: string;
  READ_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
}

interface Context {
  request: Request;
  env: Env;
}

// The largest valid body is about 3.2 KB: a 2048-character Turnstile token, a 254-character email and a
// 200-character note of 4-byte characters, plus JSON punctuation. 4 KB fits it with room to spare.
export const MAX_BODY_BYTES = 4096;
const MAX_EMAIL_LENGTH = 254;
const MAX_NOTE_LENGTH = 200;
// Shape only; the Worker does the real email validation.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

/** The body as text, or null when it is larger than MAX_BODY_BYTES (declared or actual). */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

interface Submission {
  upstream: { email: string; note?: string };
  token: unknown;
}

/** Minimal shape check. Never yields `note: null` or `note: ''` (the Worker rejects null). */
function parseSubmission(value: unknown): Submission | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { email, note, token } = value as Record<string, unknown>;
  if (typeof email !== 'string') return null;
  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(cleanEmail)) return null;
  const upstream: Submission['upstream'] = { email: cleanEmail };
  if (note !== undefined) {
    if (typeof note !== 'string') return null;
    const cleanNote = note.trim();
    if (cleanNote.length > MAX_NOTE_LENGTH) return null;
    if (cleanNote) upstream.note = cleanNote;
  }
  if (token !== undefined && (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)) return null;
  return { upstream, token };
}

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.TURNSTILE_SECRET?.trim() || !env.TURNSTILE_SITE_KEY?.trim() || !env.WORKER_URL || !env.READ_TOKEN) {
    return json(503, { error: 'Enrolment is not available' });
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'Unsupported media type' });
  }
  const text = await readCapped(request);
  if (text === null) return json(413, { error: 'Request too large' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { error: 'Invalid request' });
  }
  const submission = parseSubmission(parsed);
  if (!submission) return json(400, { error: 'Invalid request' });

  const ip = request.headers.get('CF-Connecting-IP')?.trim() || null;
  if (!(await verifyTurnstile(submission.token, env.TURNSTILE_SECRET, ip))) {
    return json(403, { error: 'Verification failed' });
  }

  // Built from scratch: no client header (cookies, Authorization, X-Viewer-Email, X-Client-IP) is forwarded.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.READ_TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (ip) headers['X-Client-IP'] = ip;

  let status: number;
  let body: string;
  try {
    const response = await fetch(`${env.WORKER_URL.replace(/\/$/, '')}/enroll`, {
      method: 'POST',
      headers,
      body: JSON.stringify(submission.upstream),
    });
    status = response.status;
    body = await response.text();
  } catch {
    return json(502, { error: 'Upstream unavailable' });
  }
  // Only the status and the Worker's small JSON body are relayed; no upstream header (set-cookie included).
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};

export const onRequest = (ctx: Context): Promise<Response> | Response =>
  ctx.request.method === 'POST'
    ? onRequestPost(ctx)
    : json(405, { error: 'Method not allowed' }, { Allow: 'POST' });
