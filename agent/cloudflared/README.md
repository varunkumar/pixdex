# Cloudflare Tunnel for originals

One-time setup (requires a Cloudflare account with a domain on it):

1. Install `cloudflared` (e.g. `brew install cloudflared` on macOS).
2. Log in and create the tunnel:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create pixdex-originals
   ```

   This prints a Tunnel ID and writes credentials to
   `~/.cloudflared/<TUNNEL_ID>.json`.

3. Edit `agent/cloudflared/config.yml`: replace both `<TUNNEL_ID>` placeholders
   with the ID from step 2, and `<your-domain>` with a domain in your
   Cloudflare account.
4. Route DNS for that hostname to the tunnel:

   ```bash
   cloudflared tunnel route dns pixdex-originals pixdex-originals.<your-domain>
   ```

5. Set `ORIGINALS_TOKEN` in `agent/.env` to a random secret. Then give the
   frontend's Pages Function the same secret and the tunnel URL, as Pages
   secrets (production and preview) named `ORIGINALS_TOKEN` and
   `ORIGINALS_BASE_URL=https://pixdex-originals.<your-domain>`. For local dev,
   put the same two in the root `.env` (see `.env.example`). The browser only
   ever requests `/api/originals/:id`; the token is sent server-side as a
   Bearer header.

## Optional: Access service token on the hostname

Defense in depth on top of the bearer token. In Zero Trust:

1. Access > Service auth > Create service token (e.g. `pixdex-originals-proxy`).
   Copy the Client ID and Client Secret (the secret is shown once).
2. Access > Applications > Add > Self-hosted, destination
   `pixdex-originals.<your-domain>`, with a policy whose action is
   **Service Auth** including that token. Do not add a human/email policy: it
   would never match the proxy.
3. Set `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` as Pages secrets
   (production and preview), and in the root `.env` for local dev.

Set the secrets before enabling the Access app; the proxy sends the headers
only when both are present.

## Running it

Two processes need to be running at the same time on the machine that has
your local photos:

```bash
# terminal 1, from agent/
npm run dev -- serve-originals

# terminal 2, from anywhere
cloudflared tunnel --config agent/cloudflared/config.yml run pixdex-originals
```

If either one isn't running, "View Original" links for local-disk photos in
the web UI simply fail to load — this is expected, not a bug to chase; see
the spec's Global Constraints on this.
