# notion-caldav

A Cloudflare Worker that syncs Notion database pages into iCloud (Apple)
calendars in near real time. When a page with a date changes in Notion, Notion
fires a webhook, the Worker fetches the page and writes/updates/deletes the
matching event in iCloud over CalDAV. Multiple Notion databases can each be
routed to their own calendar (see `DB_CONFIGS` below).

- One-way: Notion is the source of truth. Edits made in Apple Calendar are
  overwritten on the next Notion change.
- Near real time: Notion delivers events within about a minute (some are
  batched), so that is the practical floor.

The Worker also runs a weekly habit/schedule generator on a cron — see
[Habit/schedule generator](#habitschedule-generator-optional) below. That part
is specific to Calvin's Notion workspace (hardcoded database/data-source IDs),
not a generic feature of this repo.

## Project layout

```
notion-caldav/
  src/index.js           the whole Worker (sync + habit generator)
  wrangler.toml           config: DB_CONFIGS vars, cron triggers
  package.json             deploy / tail scripts
  push-schedule.js         one-off: backfill Topic relations on Schedule DB
  setup-schedule-db.js     one-off: add properties to the Schedule DB
  README.md                this file
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
3. Each synced database gets one entry in the `DB_CONFIGS` array at the top of
   `src/index.js`, e.g.:

   ```js
   { name: "TASKS", dbVar: "NOTION_DB_TASKS", dateVar: "DATE_PROP_TASKS", calVar: "ICLOUD_CALENDAR_URL_TASKS" },
   ```

   Then set the matching non-secret vars in `wrangler.toml` under `[vars]`:
   `DATE_PROP_<NAME>` (the exact Notion date column name) and
   `NOTION_DB_<NAME>` (the database ID from its page URL). Repeat Steps 1-2
   and this step per database, reusing one Worker/webhook for all of them.

## Step 4 - Deploy

Secrets are per-database (`ICLOUD_CALENDAR_URL_<NAME>`), matching the
`calVar` set in `DB_CONFIGS`:

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put ICLOUD_USER
npx wrangler secret put ICLOUD_APP_PW
npx wrangler secret put ICLOUD_CALENDAR_URL_TASKS   # one per DB_CONFIGS entry
npx wrangler secret put NOTION_VERIFICATION_TOKEN   # placeholder for now, e.g. temp
npm run deploy
```

Optional: `NTFY_TOPIC` and `NTFY_TOKEN` push an [ntfy.sh](https://ntfy.sh)
notification on each synced event. Use a registered ntfy account/token —
anonymous publishing hits ntfy's shared-IP rate limit quickly.

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

## Habit/schedule generator (optional)

The Worker also reads a "Schedule" database (recurring habit definitions —
days of week, time-of-day bucket, duration, persistent vs. one-off) and
auto-generates that week's pages in a "Habits" database, with computed
start/end times. This part is specific to Calvin's Notion workspace: the
Schedule/Habits data-source IDs (`SCHEDULE_DS_ID`, `HABITS_DS_ID`) and the
Topic-name mapping in `push-schedule.js` are hardcoded, not configurable via
`wrangler.toml` like `DB_CONFIGS` is.

- `GET /generate` — dispatches this week's generation, split into two
  sub-invocations (`/_gen?b=0` Mon-Thu, `/_gen?b=1` Fri-Sun) to stay under the
  free-plan 50-subrequest-per-invocation limit.
- `scheduled()` cron — same generation, fires automatically. See
  `[triggers] crons` in `wrangler.toml` (currently Sunday 00:00 and 00:15 CST).
- `GET /cleanup` — archives orphaned Habits pages (no `Event Time` set,
  usually from Notion's own template "Repeat" automations, not this Worker).
  Batches itself (`CLEANUP_BATCH_SIZE`) and re-dispatches until the backlog
  clears; if the "Repeat" setting is still on for any Habits templates, this
  will keep needing to be re-run — turn it off in Notion (Habits DB -> ... ->
  Templates) instead of relying on `/cleanup` to keep sweeping up after it.

`setup-schedule-db.js` and `push-schedule.js` are one-off local scripts (run
with `node`, not deployed) used to provision the Schedule database's
properties and backfill Topic relations — not part of the Worker itself.

## Gotchas

- `DATE_PROP_<NAME>` must match the Notion column name exactly, or nothing
  gets a date and nothing syncs for that database.
- The app-specific password grants broad iCloud calendar access. It lives only
  as a Worker secret; revoke it anytime at appleid.apple.com.
- Once a Notion webhook URL is verified it cannot be changed. To point at a new
  URL you must delete and recreate the subscription.
- Deploys are manual (`npm run deploy` / `wrangler deploy`) and not currently
  tied to git — check `wrangler deployments list` and match timestamps against
  `git log` if you need to know what's actually live.
