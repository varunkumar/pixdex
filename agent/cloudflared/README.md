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

5. Set `ORIGINALS_TOKEN` in `agent/.env` to a random secret, and set
   `VITE_ORIGINALS_BASE_URL=https://pixdex-originals.<your-domain>` and
   `VITE_ORIGINALS_TOKEN=<the same secret>` in the frontend's `.env`
   (see the root `.env.example`).

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
