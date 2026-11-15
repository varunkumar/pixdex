// Public enroll page: GET /enroll (HEAD too; every other method answers 405). Outside Cloudflare Access (Bypass application on /enroll and
// /api/enroll), so it cannot use the React bundle under /assets/* (that stays behind Access). The page is
// self-contained: inline CSS and script, each allowed only by a per-response CSP nonce, plus the Turnstile
// widget from challenges.cloudflare.com. It posts JSON to /api/enroll (functions/api/enroll.ts).
//
// The only interpolated value is the public TURNSTILE_SITE_KEY, attribute-escaped. The script shows only
// its own fixed messages through textContent; it never renders anything the server returns.
// Cost: no subrequest, no Worker call, no D1. Never cached (no-store), by design.

interface Env {
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
}

interface Context {
  request: Request;
  env: Env;
}

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --ink: #1d2330; --muted: #5b6475; --line: #d6dae2;
  --accent: #228be6; --accent-ink: #ffffff; --ok: #2b8a3e; --err: #c92a2a; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1a1b1e; --card: #25262b; --ink: #e9ecef; --muted: #a6adbb; --line: #3a3c42; --accent: #4dabf7;
    --accent-ink: #10141a; --ok: #69db7c; --err: #ff8787; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
h1 { margin: 0 0 4px; font-size: 1.4rem; }
p { margin: 0 0 16px; color: var(--muted); }
label { display: block; font-weight: 600; margin: 12px 0 4px; }
input, textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font: inherit;
  background: var(--bg); color: var(--ink); }
textarea { resize: vertical; min-height: 72px; }
.hint { font-weight: 400; color: var(--muted); font-size: 0.875rem; }
.cf-turnstile { margin: 16px 0; min-height: 65px; }
button { width: 100%; padding: 10px; border: 0; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
  background: var(--accent); color: var(--accent-ink); }
button:disabled { opacity: 0.6; cursor: default; }
#status { margin: 16px 0 0; min-height: 1.5em; }
#status.ok { color: var(--ok); }
#status.err { color: var(--err); }
`;

// Fixed messages only; the response body is never read into the page.
const SCRIPT = `
(function () {
  var form = document.getElementById('enroll-form');
  var status = document.getElementById('status');
  var button = document.getElementById('submit');
  var RECEIVED = 'Request received. If approved you will be able to sign in with this email.';
  function show(text, kind) {
    status.textContent = text;
    status.className = kind;
  }
  function resetWidget() {
    if (window.turnstile && typeof window.turnstile.reset === 'function') window.turnstile.reset();
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = new FormData(form);
    var token = data.get('cf-turnstile-response');
    if (!token) {
      show('Please complete the check above first.', 'err');
      return;
    }
    var body = { email: String(data.get('email') || ''), token: String(token) };
    var note = String(data.get('note') || '').trim();
    if (note) body.note = note;
    button.disabled = true;
    show('Sending...', '');
    fetch('/api/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store'
    }).then(function (response) {
      if (response.status === 202) {
        form.hidden = true;
        show(RECEIVED, 'ok');
        return;
      }
      button.disabled = false;
      resetWidget();
      if (response.status === 429) show('Too many requests. Please wait a minute and try again.', 'err');
      else if (response.status === 400) show('Please check the email address and note.', 'err');
      else if (response.status === 403) show('The check did not pass. Please try again.', 'err');
      else show('Something went wrong. Please try again later.', 'err');
    }).catch(function () {
      button.disabled = false;
      resetWidget();
      show('Could not reach the server. Please try again later.', 'err');
    });
  });
})();
`;

function page(nonce: string, siteKey: string | null): string {
  const body = siteKey
    ? `<h1>Request access</h1>
<p>PixdeX is invite-only. Leave your email and the owner will review your request.</p>
<form id="enroll-form" method="post" novalidate>
<label for="email">Email</label>
<input id="email" name="email" type="email" required maxlength="254" autocomplete="email" inputmode="email">
<label for="note">Note <span class="hint">(optional, who you are)</span></label>
<textarea id="note" name="note" maxlength="200"></textarea>
<div class="cf-turnstile" data-sitekey="${escapeAttribute(siteKey)}" data-theme="auto"></div>
<button id="submit" type="submit">Request access</button>
</form>
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript.</p></noscript>
<script nonce="${nonce}" src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>
<script nonce="${nonce}">${SCRIPT}</script>`
    : `<h1>Request access</h1>
<p>Enrolment is not available right now. Please ask the owner directly.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Request access - PixdeX</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export const onRequestGet = ({ env }: { env: Env }): Response => {
  const nonce = makeNonce();
  // Without both Turnstile values the endpoint answers 503, so the page shows no form or widget at all.
  const siteKey = (env.TURNSTILE_SECRET?.trim() && env.TURNSTILE_SITE_KEY?.trim()) || null;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `style-src 'nonce-${nonce}'`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `connect-src 'self' ${TURNSTILE_ORIGIN}`,
    "img-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
  return new Response(page(nonce, siteKey), {
    status: siteKey ? 200 : 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    },
  });
};

// Every other method answers 405 here instead of falling through to another handler (mirrors
// functions/api/enroll.ts). HEAD is served by the GET handler; the runtime drops the body.
export const onRequest = (ctx: Context): Response =>
  ctx.request.method === 'GET' || ctx.request.method === 'HEAD'
    ? onRequestGet(ctx)
    : new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'GET, HEAD' },
      });
