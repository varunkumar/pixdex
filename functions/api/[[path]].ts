// Same-origin read proxy for the Worker. The browser calls /api/* on the Pages
// origin (already behind Cloudflare Access); this function adds the shared read
// token server-side so it never ships in the frontend bundle or in URLs.

interface Env {
  WORKER_URL: string;
  READ_TOKEN: string;
  // Cloudflare Tunnel to the local originals server (optional until set up).
  ORIGINALS_BASE_URL?: string;
  ORIGINALS_TOKEN?: string;
  // Cloudflare Access service token for the tunnel hostname. Optional: sent only
  // when both are set, so Access can be enabled on the hostname independently.
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}

interface Context {
  request: Request;
  env: Env;
}

// Only the Worker's read routes are reachable through the proxy. /ingest/* and
// anything else is deliberately not forwarded.
const ALLOWED_PATHS = [
  /^search$/,
  /^albums$/,
  /^daily-pick$/,
  /^photos\/[^/]+$/,
  /^thumbnails\/[^/]+$/,
  /^people$/,
  /^people\/groups$/,
  /^photos\/[^/]+\/faces$/,
];

// Full-resolution local-disk originals, served by the agent through a tunnel.
const ORIGINALS_PATH = /^originals\/[^/]+$/;

// Request headers worth forwarding. Cookies (incl. the Access session) and any
// client-supplied Authorization are intentionally dropped.
const FORWARDED_HEADERS = ['accept', 'if-none-match', 'if-modified-since', 'range'];

// Thumbnails are addressed by content hash, so they never change and can be
// cached hard. Everything else (search, albums, daily pick, photo metadata)
// changes as photos are indexed and must be revalidated on every request.
// Originals are large and stable per id, so a short cache is fine. Errors are
// never cached.
function cacheControlFor(path: string, ok: boolean): string {
  if (!ok) return 'no-store';
  if (path.startsWith('thumbnails/')) return 'private, max-age=31536000, immutable';
  if (ORIGINALS_PATH.test(path)) return 'private, max-age=3600';
  return 'private, no-cache';
}

export const onRequestGet = async ({ request, env }: Context): Promise<Response> => {
  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/^\/api\//, '');

  const isOriginal = ORIGINALS_PATH.test(path);
  if (!isOriginal && !ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
    return new Response('Not found', { status: 404 });
  }

  const baseUrl = isOriginal ? env.ORIGINALS_BASE_URL : env.WORKER_URL;
  const token = isOriginal ? env.ORIGINALS_TOKEN : env.READ_TOKEN;
  if (!baseUrl || !token) {
    return new Response('Proxy is not configured', { status: 500 });
  }

  const upstream = new URL(`${baseUrl.replace(/\/$/, '')}/${path}`);
  incoming.searchParams.forEach((value, key) => {
    if (key !== 'token') upstream.searchParams.append(key, value);
  });

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Authorization', `Bearer ${token}`);
  if (isOriginal && env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {
    headers.set('CF-Access-Client-Id', env.ACCESS_CLIENT_ID);
    headers.set('CF-Access-Client-Secret', env.ACCESS_CLIENT_SECRET);
  }

  let response: Response;
  try {
    response = await fetch(upstream, { headers });
  } catch {
    // e.g. the tunnel is down because the local machine is off.
    return new Response('Upstream unavailable', { status: 502 });
  }
  const out = new Response(response.body, response);
  // Never relay upstream cookies. The tunnel's Access app replies to service-token
  // requests with its own CF_Authorization cookie; passed through, it would replace
  // the user's session cookie for this origin and make Access reject later calls.
  out.headers.delete('set-cookie');
  out.headers.set('Cache-Control', cacheControlFor(path, response.ok));
  return out;
};

// Browser writes. Each method has its own narrow allowlist. Bodies are JSON only,
// so a cross-origin form post cannot trigger them (it would need a CORS preflight).
const WRITE_PATHS: Record<'PUT' | 'POST' | 'PATCH' | 'DELETE', RegExp[]> = {
  // Choosing an album's cover.
  PUT: [/^albums\/cover$/],
  // Creating people, assigning faces to people, and face review.
  POST: [
    /^people$/,
    /^people\/[^/]+\/faces$/,
    /^people\/[^/]+\/match$/,
    /^faces\/[^/]+\/(assign|reject|unassign)$/,
  ],
  // Human review of one photo (rating, title, subjects, tags); renaming a person.
  PATCH: [/^photos\/[^/]+$/, /^people\/[^/]+$/],
  DELETE: [/^people\/[^/]+$/],
};

// Forward one allowed browser write to the Worker with the server-side token.
// Client headers (cookies, Authorization) are never forwarded; upstream cookies
// are never relayed; responses are never cached.
async function forwardWrite(
  method: keyof typeof WRITE_PATHS,
  { request, env }: Context
): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/api\//, '');
  if (!WRITE_PATHS[method].some((pattern) => pattern.test(path))) {
    return new Response('Not found', { status: 404 });
  }
  const hasBody = method !== 'DELETE';
  if (hasBody && !request.headers.get('content-type')?.startsWith('application/json')) {
    return new Response('Unsupported media type', { status: 415 });
  }
  if (!env.WORKER_URL || !env.READ_TOKEN) return new Response('Proxy is not configured', { status: 500 });

  const headers: Record<string, string> = { Authorization: `Bearer ${env.READ_TOKEN}` };
  if (hasBody) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${env.WORKER_URL.replace(/\/$/, '')}/${path}`, {
      method,
      headers,
      ...(hasBody ? { body: await request.text() } : {}),
    });
  } catch {
    return new Response('Upstream unavailable', { status: 502 });
  }
  const out = new Response(response.body, response);
  out.headers.delete('set-cookie');
  out.headers.set('Cache-Control', 'no-store');
  return out;
}

export const onRequestPut = (ctx: Context): Promise<Response> => forwardWrite('PUT', ctx);
export const onRequestPost = (ctx: Context): Promise<Response> => forwardWrite('POST', ctx);
export const onRequestPatch = (ctx: Context): Promise<Response> => forwardWrite('PATCH', ctx);
export const onRequestDelete = (ctx: Context): Promise<Response> => forwardWrite('DELETE', ctx);
