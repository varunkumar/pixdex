# Sharing, access and originals

## Albums

- Each album has one owner: the `OWNER_EMAIL` of the agent that indexed it. The
  agent cannot add photos to another owner's album.
- Photos without an album are not visible. Put all photos in a folder.
- The owner selects Share on the album card or page. Then the owner adds or removes
  Google sign-in emails.
- A viewer cannot rate, edit, set a cover, share or name faces.
- A viewer sees "Shared by <owner>". Avatars are made in the browser.
- When you remove access, cached images can stay in the viewer's browser.
- [People names](people.md#owners-and-names) are private.

## Set up sharing

Cloudflare Access must protect the Pages site.

1. Set the Pages variables `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
2. Set `OWNER_EMAIL` in `agent/.env`. Remove an old Worker secret of that name.
3. Deploy the Function and Worker.
4. Run `cd worker && npm run backfill-owner` once. Until then, nothing is visible.
   `--dry-run` shows the SQL. `--local` uses the local database.

For the full order, see the [Development guide](development.md).

For local tests, set `DEV_VIEWER_EMAIL` in `.env` to see the app as a viewer.

## Invite-only access

Only members of the Access group `pixdex-approved` can sign in. Other people ask
for access on the public `/enroll` page (with Turnstile). The administrator
(`ADMIN_EMAIL`) approves, denies or revokes on `/admin/access`. To share an album
does not give sign-in access.

1. Make the group, a Bypass application for only `/enroll` and `/api/enroll`, and
   a Turnstile widget.
2. Set the Pages variables `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`.
3. Set the Worker secrets `ADMIN_EMAIL`, `CF_API_TOKEN`, `CF_ACCOUNT_ID` and
   `CF_ACCESS_GROUP_ID`. Give the token only "Access: Organizations, Identity
   Providers, and Groups Write".
4. Merge. Then run `cd worker && npm run seed-access -- --dry-run`, then
   `npm run seed-access`.
5. Change the Access policy to the group.

Change `namespace_id` of `ENROLL_LIMITER` in `worker/wrangler.toml` only if your
account already uses it. Do the full steps in "Rollout order for invite-only
access" in the [Development guide](development.md).

## Originals

Pages show thumbnails. "View Original" and the cover banner need the originals
server.

1. Obey the steps in [agent/cloudflared](../agent/cloudflared/README.md).
2. Set `ORIGINALS_BASE_URL` and `ORIGINALS_TOKEN` as Pages secrets, and in `.env`
   for local use.
3. For Google Drive photos, sign in with `index-drive` first.
4. Run `npm run dev -- serve-originals` in `agent/`.

The browser uses only `/api/originals/:id`. It never gets the tunnel URL or token.
The owner can also select "Open in Google Drive".
