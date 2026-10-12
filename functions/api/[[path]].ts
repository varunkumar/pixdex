// Same-origin read proxy for the Worker. The browser calls /api/* on the Pages
// origin (already behind Cloudflare Access); this function adds the shared read
// token server-side so it never ships in the frontend bundle or in URLs.

interface Env {
  WORKER_URL: string;
  READ_TOKEN: string;
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
];

// Request headers worth forwarding. Cookies (incl. the Access session) and any
// client-supplied Authorization are intentionally dropped.
const FORWARDED_HEADERS = ['accept', 'if-none-match', 'if-modified-since', 'range'];

export const onRequestGet = async ({ request, env }: Context): Promise<Response> => {
  if (!env.WORKER_URL || !env.READ_TOKEN) {
    return new Response('Proxy is not configured', { status: 500 });
  }

  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/^\/api\//, '');
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
    return new Response('Not found', { status: 404 });
  }

  const upstream = new URL(`${env.WORKER_URL.replace(/\/$/, '')}/${path}`);
  incoming.searchParams.forEach((value, key) => {
    if (key !== 'token') upstream.searchParams.append(key, value);
  });

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Authorization', `Bearer ${env.READ_TOKEN}`);

  const response = await fetch(upstream, { headers });
  const out = new Response(response.body, response);
  out.headers.set('Cache-Control', 'private, max-age=3600');
  return out;
};
