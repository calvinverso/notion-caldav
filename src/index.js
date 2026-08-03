// Notion -> iCloud Calendar sync (Cloudflare Worker, single file)
//
// Syncs multiple Notion databases to their own iCloud calendars. Each
// database gets a DATE_PROP_<NAME>/NOTION_DB_<NAME> var pair and an
// ICLOUD_CALENDAR_URL_<NAME> secret; add a matching entry to DB_CONFIGS below.
//
// Required secrets (npx wrangler secret put ...):
//   NOTION_TOKEN                 integration token (starts with ntn_)
//   NOTION_VERIFICATION_TOKEN    the webhook signing secret (see README step 5)
//   ICLOUD_USER                  your Apple ID email
//   ICLOUD_APP_PW                16-char app-specific password from appleid.apple.com
//   ICLOUD_CALENDAR_URL_<NAME>   full CalDAV collection URL for that calendar (ends in .../<uuid>/)
// Required vars (wrangler.toml [vars]), per database:
//   DATE_PROP_<NAME>             exact name of the Notion date column, e.g. "Due"
//   NOTION_DB_<NAME>             that database's id (from its page URL)

const DB_CONFIGS = [
  { name: "HABITS", dbVar: "NOTION_DB_HABITS", dateVar: "DATE_PROP_HABITS", calVar: "ICLOUD_CALENDAR_URL_HABITS" },
  { name: "TASKS", dbVar: "NOTION_DB_TASKS", dateVar: "DATE_PROP_TASKS", calVar: "ICLOUD_CALENDAR_URL_TASKS" },
];

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("ok", { status: 200 });

    const raw = await request.text();
    let body;
    try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

    // Step 1: one-time verification handshake. Notion POSTs the token once.
    // Grab it from the logs (npm run tail), paste it into Notion's Verify form,
    // then store it as NOTION_VERIFICATION_TOKEN and redeploy.
    if (body.verification_token) {
      console.log("NOTION_VERIFICATION_TOKEN =", body.verification_token);
      return new Response("ok", { status: 200 });
    }

    // Step 2: verify the signature on every real event.
    const sig = request.headers.get("X-Notion-Signature") || "";
    if (!(await verifySignature(raw, sig, env.NOTION_VERIFICATION_TOKEN))) {
      return new Response("bad signature", { status: 401 });
    }

    // Step 3: ack fast (Notion has a strict timeout), process in the background.
    ctx.waitUntil(handleEvent(body, env).catch((e) => console.error(e)));
    return new Response("ok", { status: 200 });
  },
};

async function verifySignature(raw, header, secret) {
  if (!secret || !header.startsWith("sha256=")) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual("sha256=" + hex, header);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function handleEvent(body, env) {
  const entity = body.entity || {};
  if (entity.type !== "page") return; // ignore comments, schema changes, etc.
  const pageId = entity.id;
  const type = body.type || "";

  // Deleted pages can't be fetched to learn which database they belonged to,
  // so clear them out of every configured calendar (a miss is just a 404).
  if (type.includes("deleted")) return caldavDeleteAll(pageId, env);

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2026-03-11",
    },
  });
  if (res.status === 404) return caldavDeleteAll(pageId, env);
  if (!res.ok) throw new Error(`notion ${res.status}`);

  const page = await res.json();
  if (page.archived || page.in_trash) return caldavDeleteAll(pageId, env);

  const config = configForDatabase(page.parent?.database_id, env);
  if (!config) return; // page isn't in a database we're syncing

  const date = page.properties?.[config.dateProp]?.date;
  if (!date?.start) return caldavDelete(pageId, config.calendarUrl, env); // no date -> not a calendar item

  const title = extractTitle(page.properties);
  await caldavPut(pageId, buildICS(pageId, title, date, page.url), config.calendarUrl, env);
}

function configForDatabase(databaseId, env) {
  const id = normalizeId(databaseId);
  if (!id) return null;
  for (const c of DB_CONFIGS) {
    if (normalizeId(env[c.dbVar]) === id) {
      return { dateProp: env[c.dateVar], calendarUrl: env[c.calVar] };
    }
  }
  return null;
}

const normalizeId = (id) => (id || "").replace(/-/g, "");

function extractTitle(props) {
  for (const k in props) {
    if (props[k].type === "title") {
      return (props[k].title || []).map((t) => t.plain_text).join("") || "Untitled";
    }
  }
  return "Untitled";
}

function buildICS(pageId, title, date, url) {
  const now = toUTC(new Date());
  const allDay = !date.start.includes("T");
  let dtstart, dtend;

  if (allDay) {
    const start = new Date(date.start + "T00:00:00Z");
    const endBase = new Date((date.end || date.start) + "T00:00:00Z");
    const end = new Date(endBase.getTime() + 86400000); // DTEND is exclusive
    dtstart = `DTSTART;VALUE=DATE:${fmtDate(start)}`;
    dtend = `DTEND;VALUE=DATE:${fmtDate(end)}`;
  } else {
    const start = new Date(date.start);
    const end = date.end ? new Date(date.end) : new Date(start.getTime() + 3600000);
    dtstart = `DTSTART:${toUTC(start)}`;
    dtend = `DTEND:${toUTC(end)}`;
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//notion-caldav//EN",
    "BEGIN:VEVENT",
    `UID:${pageId}`,
    `DTSTAMP:${now}`,
    dtstart,
    dtend,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(url)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const toUTC = (d) =>
  `${fmtDate(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const esc = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

function calUrl(pageId, calendarUrl) {
  const base = calendarUrl.endsWith("/") ? calendarUrl : calendarUrl + "/";
  return base + pageId + ".ics";
}
const authHeader = (env) => "Basic " + btoa(`${env.ICLOUD_USER}:${env.ICLOUD_APP_PW}`);

async function caldavPut(pageId, ics, calendarUrl, env) {
  const r = await fetch(calUrl(pageId, calendarUrl), {
    method: "PUT",
    headers: { Authorization: authHeader(env), "Content-Type": "text/calendar; charset=utf-8" },
    body: ics,
  });
  if (![200, 201, 204].includes(r.status)) throw new Error(`caldav put ${r.status}`);
}

async function caldavDelete(pageId, calendarUrl, env) {
  const r = await fetch(calUrl(pageId, calendarUrl), {
    method: "DELETE",
    headers: { Authorization: authHeader(env) },
  });
  if (r.status !== 404 && !r.ok) throw new Error(`caldav delete ${r.status}`); // 404 = already gone
}

async function caldavDeleteAll(pageId, env) {
  for (const c of DB_CONFIGS) {
    const calendarUrl = env[c.calVar];
    if (calendarUrl) await caldavDelete(pageId, calendarUrl, env);
  }
}
