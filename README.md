# notion-caldav

A tiny Cloudflare Worker that syncs a Notion database into an iCloud (Apple)
calendar in near real time. When a page with a date changes in Notion, Notion
fires a webhook, the Worker fetches the page and writes/updates/deletes the
matching event in iCloud over CalDAV.

- One-way: Notion is the source of truth. Edits made in Apple Calendar are
  overwritten on the next Notion change.
- Near real time: Notion delivers events within about a minute (some are
  batched), so that is the practical floor.

## Project layout

```
notion-caldav/
  src/index.js     the whole Worker
  wrangler.toml    config + DATE_PROP var
  package.json     deploy / tail scripts
  README.md        this file
```

## What Claude Code can do vs what you must do yourself

Claude Code can run every terminal step below (curl discovery, wrangler
secrets, deploy, tail). Two things only you can do, because they live in
external UIs:

1. Generate the Apple app-specific password at appleid.apple.com.
2. Paste the Notion verification token into Notion's Verify form (step 5).

---

## Step 1 - Apple side

1. At https://appleid.apple.com -> Sign-In and Security -> App-Specific
   Passwords, generate one. Save the 16-char value. This is `ICLOUD_APP_PW`.
   Your Apple ID email is `ICLOUD_USER`.
2. In Apple Calendar, create a dedicated calendar named **Notion** (so synced
   tasks stay isolated and are easy to wipe). Give iCloud a moment to sync it.

## Step 2 - Discover your CalDAV calendar URL

Run these three PROPFINDs. Replace credentials, and feed each step's output
into the next.

```bash
# a) find your principal path
curl -s -X PROPFIND "https://caldav.icloud.com/" \
  -u "$ICLOUD_USER:$ICLOUD_APP_PW" -H "Depth: 0" -H "Content-Type: text/xml" \
  --data '<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>'

# b) find your calendar home (use PRINCIPAL_PATH from step a)
curl -s -X PROPFIND "https://caldav.icloud.com/PRINCIPAL_PATH/" \
  -u "$ICLOUD_USER:$ICLOUD_APP_PW" -H "Depth: 0" -H "Content-Type: text/xml" \
  --data '<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><c:calendar-home-set/></prop></propfind>'

# c) list calendars, find the one named "Notion" (use the pXX host from step b)
curl -s -X PROPFIND "https://pXX-caldav.icloud.com/DSID/calendars/" \
  -u "$ICLOUD_USER:$ICLOUD_APP_PW" -H "Depth: 1" -H "Content-Type: text/xml" \
  --data '<propfind xmlns="DAV:"><prop><displayname/></prop></propfind>'
```

The full collection URL for the Notion calendar (ends in its UUID and a slash)
is `ICLOUD_CALENDAR_URL`, e.g.
`https://p51-caldav.icloud.com/1234567890/calendars/AAAA-BBBB-CCCC/`.

## Step 3 - Notion side

1. https://www.notion.so/profile/integrations -> New integration (internal).
   Copy the token (starts with `ntn_`). This is `NOTION_TOKEN`.
2. Open your task database as a full page -> Share -> invite the integration.
3. Note the EXACT name of your date column and set it in `wrangler.toml`
   under `[vars] DATE_PROP` (default is `"Due"`).

## Step 4 - Deploy

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put ICLOUD_USER
npx wrangler secret put ICLOUD_APP_PW
npx wrangler secret put ICLOUD_CALENDAR_URL
npx wrangler secret put NOTION_VERIFICATION_TOKEN   # placeholder for now, e.g. temp
npm run deploy
```

Note the deployed URL, e.g. `https://notion-caldav.<you>.workers.dev`.

## Step 5 - Wire up the webhook (the fiddly part)

1. In your Notion integration -> Webhooks tab -> Create a subscription. Paste
   the Worker URL. Subscribe to page created / updated / deleted.
2. Notion sends a one-time verification POST. Capture the token from the logs:

   ```bash
   npm run tail
   ```

   Look for `NOTION_VERIFICATION_TOKEN = ...`.
3. Paste that token into Notion's Verify subscription form to activate.
4. Store it for real and redeploy so signature checks pass:

   ```bash
   npx wrangler secret put NOTION_VERIFICATION_TOKEN   # paste the same token
   npm run deploy
   ```

## Test

Add or edit a dated page in the Notion database, then check the Notion
calendar in Apple Calendar within a minute. `npm run tail` shows live logs and
any errors.

## Gotchas

- `DATE_PROP` must match the Notion column name exactly, or nothing gets a date
  and nothing syncs.
- The app-specific password grants broad iCloud calendar access. It lives only
  as a Worker secret; revoke it anytime at appleid.apple.com.
- Once a Notion webhook URL is verified it cannot be changed. To point at a new
  URL you must delete and recreate the subscription.
