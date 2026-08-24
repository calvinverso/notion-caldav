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
//   NTFY_TOPIC                   optional: ntfy.sh topic to push a notification on each synced event
//   NTFY_TOKEN                   optional: ntfy.sh account access token (avoids the shared anonymous rate limit)
// Required vars (wrangler.toml [vars]), per database:
//   DATE_PROP_<NAME>             exact name of the Notion date column, e.g. "Due"
//   NOTION_DB_<NAME>             that database's id (from its page URL)

const DB_CONFIGS = [
  { name: "HABITS", dbVar: "NOTION_DB_HABITS", dateVar: "DATE_PROP_HABITS", calVar: "ICLOUD_CALENDAR_URL_HABITS" },
  { name: "TASKS", dbVar: "NOTION_DB_TASKS", dateVar: "DATE_PROP_TASKS", calVar: "ICLOUD_CALENDAR_URL_TASKS" },
];

// data_source IDs for querying via /v1/data_sources/{id}/query (differ from URL IDs)
const SCHEDULE_DS_ID = "3b2835b1-75d8-808f-9b27-000b89048e78";
const HABITS_DS_ID   = "1b9835b1-75d8-809b-afba-000bdc55999d";

// Maps Schedule "Days" multi-select abbreviations to weekDates index (Mon=0 … Sun=6)
const DAY_INDEX = { M: 0, T: 1, W: 2, Th: 3, F: 4, Sa: 5, Su: 6 };

// Anchor start hour (decimal, CST) for each "Part of Day" bucket. Entries that fall back to
// a bucket (no explicit Start Time) get Duration-sized slots stacked from this anchor — see
// assignPartOfDaySlots. Explicit Start Time on an entry always takes priority over this.
const PART_OF_DAY_START = {
  "Early Morning": 5,
  "Morning":       7,   // runs through the Morning–Noon gap up to 12
  "Noon":          12,
  "Afternoon":     13,
  "Evening":       17,
  "Night":         20,
};

const DEFAULT_DURATION_HOURS = 0.5; // used whenever a Schedule entry has no Duration set

// Lower rank schedules earlier within a shared day+bucket slot. Unset = "Middle".
const SEQUENCE_RANK = { First: 0, Middle: 1, Last: 2 };

// CST = UTC-6 (ignoring DST — close enough for week boundary calculations)
const CST_OFFSET_MS = -6 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Manual trigger: dispatches two sub-invocations so each stays under the 50-subrequest limit
    if (url.pathname === "/generate") {
      const base = url.origin;
      ctx.waitUntil(
        Promise.all([
          fetch(`${base}/_gen?b=0`).catch(e => console.error("gen b0:", e)),
          fetch(`${base}/_gen?b=1`).catch(e => console.error("gen b1:", e)),
        ]).then(() => console.log("generate dispatch done"))
      );
      return new Response("Generating weekly habits…", { status: 202 });
    }

    // Internal batch runner (called by /generate and by the scheduled handler)
    if (url.pathname === "/_gen") {
      const batch = parseInt(url.searchParams.get("b") || "0");
      ctx.waitUntil(
        generateWeeklyHabits(env, batch)
          .then(log => console.log(`gen b${batch}:`, JSON.stringify(log)))
          .catch(e => console.error(`gen b${batch} error:`, e.message, e.stack))
      );
      return new Response("ok", { status: 200 });
    }

    // Cleanup: archives non-persistent Habits pages with no Event Time set (orphaned
    // pages from Notion's own recurring templates, or interrupted generation runs).
    // Batches itself to stay under the per-invocation subrequest limit; call GET
    // /cleanup once and it re-dispatches itself until the backlog is drained.
    if (url.pathname === "/cleanup") {
      ctx.waitUntil(cleanupOrphanedHabits(env, url.origin, ctx)
        .then(r => console.log("cleanup done:", JSON.stringify(r)))
        .catch(e => console.error("cleanup error:", e.message)));
      return new Response("Cleaning up orphaned habit pages…", { status: 202 });
    }

    if (request.method !== "POST") return new Response("ok", { status: 200 });

    const raw = await request.text();
    let body;
    try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

    if (body.verification_token) {
      console.log("NOTION_VERIFICATION_TOKEN =", body.verification_token);
      return new Response("ok", { status: 200 });
    }

    const sig = request.headers.get("X-Notion-Signature") || "";
    if (!(await verifySignature(raw, sig, env.NOTION_VERIFICATION_TOKEN))) {
      return new Response("bad signature", { status: 401 });
    }

    ctx.waitUntil(handleEvent(body, env).catch((e) => console.error(e)));
    return new Response("ok", { status: 200 });
  },

  // Cron: "0 6 * * SUN" → batch 0 (Mon–Thu), "15 6 * * SUN" → batch 1 (Fri–Sun)
  async scheduled(event, env, ctx) {
    const batch = new Date(event.scheduledTime).getUTCMinutes() < 15 ? 0 : 1;
    ctx.waitUntil(
      generateWeeklyHabits(env, batch)
        .then(log => console.log(`cron b${batch}:`, JSON.stringify(log)))
        .catch(e => console.error(`cron b${batch} error:`, e.message, e.stack))
    );
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
  if (entity.type !== "page") return;
  const pageId = entity.id;
  const type = body.type || "";

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
  if (!config) return;

  const date = page.properties?.[config.dateProp]?.date;
  if (!date?.start) return caldavDelete(pageId, config.calendarUrl, env);

  const title = extractTitle(page.properties);
  await caldavPut(pageId, buildICS(pageId, title, date, page.url), config.calendarUrl, env);
  await notify(env, title, config.name, config.dateProp, date.start);
}

async function notify(env, title, dbName, dateProp, start) {
  if (!env.NTFY_TOPIC) return;
  try {
    const headers = { Title: "Calendar synced" };
    if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
    const body = [title, `${dbName} — ${dateProp}: ${start}`, `Synced: ${new Date().toISOString()}`].join("\n");
    const r = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers, body });
    if (!r.ok) console.error(`ntfy ${r.status}: ${await r.text()}`);
  } catch (e) {
    console.error(`ntfy fetch failed: ${e}`);
  }
}

function configForDatabase(databaseId, env) {
  const id = normalizeId(databaseId);
  if (!id) return null;
  for (const c of DB_CONFIGS) {
    if (normalizeId(env[c.dbVar]) === id) {
      return { name: c.name, dateProp: env[c.dateVar], calendarUrl: env[c.calVar] };
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

// ── Schedule generation ───────────────────────────────────────────────────────

function notionHeaders(env) {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": "2026-03-11",
    "Content-Type": "application/json",
  };
}

function cstDate(utcMs) {
  return new Date(utcMs + CST_OFFSET_MS);
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function getWeekDates(utcMs) {
  // Returns [Mon, Tue, Wed, Thu, Fri, Sat, Sun] as YYYY-MM-DD strings (CST dates).
  // Sunday CST → generates NEXT week; Mon–Sat → generates THIS week.
  const d = cstDate(utcMs);
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const mondayOffset = dow === 0 ? 1 : 1 - dow;
  return Array.from({ length: 7 }, (_, i) => isoDate(cstDate(utcMs + (mondayOffset + i) * 86400000)));
}

function decimalToTime(decimal) {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  return `${pad(h)}:${pad(m)}:00`;
}

function buildScheduledDate(dateStr, startTime, endTime) {
  if (startTime == null) return { start: dateStr }; // all-day
  const start = `${dateStr}T${decimalToTime(startTime)}-06:00`;
  return endTime != null ? { start, end: `${dateStr}T${decimalToTime(endTime)}-06:00` } : { start };
}

async function querySchedule(env) {
  const res = await fetch(`https://api.notion.com/v1/data_sources/${SCHEDULE_DS_ID}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: { property: "Active", checkbox: { equals: true } },
      page_size: 100,
    }),
  });
  if (!res.ok) throw new Error(`schedule query ${res.status}: ${await res.text()}`);
  return (await res.json()).results || [];
}

async function fetchHabitsForWeek(weekDates, env) {
  // One query to get all habits scheduled this week. Returns Map<"Name|YYYY-MM-DD", page>.
  const res = await fetch(`https://api.notion.com/v1/data_sources/${HABITS_DS_ID}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: {
        and: [
          { property: "Event Time", date: { on_or_after: weekDates[0] } },
          { property: "Event Time", date: { on_or_before: weekDates[6] } },
        ],
      },
      page_size: 100,
    }),
  });
  const map = new Map();
  if (!res.ok) return map;
  for (const page of ((await res.json()).results || [])) {
    const name  = page.properties?.Name?.title?.[0]?.plain_text;
    const start = page.properties?.["Event Time"]?.date?.start;
    if (!name || !start) continue;
    map.set(`${name}|${start.slice(0, 10)}`, page);
  }
  return map;
}

async function fetchPendingPersistentNames(env) {
  // One query to get all habit names with no Event Time (unscheduled persistent items).
  const res = await fetch(`https://api.notion.com/v1/data_sources/${HABITS_DS_ID}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: { property: "Event Time", date: { is_empty: true } },
      page_size: 100,
    }),
  });
  const names = new Set();
  if (!res.ok) return names;
  for (const page of ((await res.json()).results || [])) {
    const name = page.properties?.Name?.title?.[0]?.plain_text;
    if (name) names.add(name);
  }
  return names;
}

async function createHabitsPage(name, dateStr, eventTime, topicRelation, icon, env) {
  const properties = {
    Name:         { title: [{ text: { content: name } }] },
    Date:         { date: { start: dateStr } },
    "Event Time": { date: eventTime },
  };
  if (topicRelation.length > 0) {
    properties["Topics"] = { relation: topicRelation.map(r => ({ id: r.id })) };
  }
  const body = { parent: { database_id: env.NOTION_DB_HABITS }, properties };
  if (icon) body.icon = icon;

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create habits page "${name}" ${res.status}: ${await res.text()}`);
  return res.json();
}

async function updateHabitsDate(pageId, dateStr, eventTime, env) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(env),
    body: JSON.stringify({
      properties: {
        Date:         { date: { start: dateStr } },
        "Event Time": { date: eventTime },
      },
    }),
  });
  if (!res.ok) throw new Error(`update habits page ${pageId} ${res.status}: ${await res.text()}`);
}

async function backfillDate(pageId, dateStr, env) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(env),
    body: JSON.stringify({ properties: { Date: { date: { start: dateStr } } } }),
  });
  if (!res.ok) throw new Error(`backfill date ${pageId} ${res.status}: ${await res.text()}`);
}

// Groups same-day/same-bucket jobs (no explicit Start Time) and stacks them into
// consecutive 30-min slots from the bucket's anchor hour, ordered by Sequence then Name.
function assignPartOfDaySlots(jobs) {
  const groups = new Map(); // "date|bucket" -> jobs[]
  for (const job of jobs) {
    if (job.explicitStart != null || !job.partOfDay) continue;
    const key = `${job.date}|${job.partOfDay}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const [key, group] of groups) {
    const bucket = key.slice(key.indexOf("|") + 1);
    group.sort((a, b) =>
      (SEQUENCE_RANK[a.sequence] ?? SEQUENCE_RANK.Middle) - (SEQUENCE_RANK[b.sequence] ?? SEQUENCE_RANK.Middle) ||
      a.name.localeCompare(b.name)
    );
    let offset = PART_OF_DAY_START[bucket];
    for (const job of group) {
      const duration = job.duration ?? DEFAULT_DURATION_HOURS;
      job.slotStart = offset;
      job.slotEnd   = offset + duration;
      offset += duration;
    }
  }
}

async function generateWeeklyHabits(env, batch = 0) {
  // batch 0 = Mon–Thu (indices 0-3), batch 1 = Fri–Sun (indices 4-6)
  const batchDays = batch === 0 ? new Set([0, 1, 2, 3]) : new Set([4, 5, 6]);
  const weekDates = getWeekDates(Date.now()); // [Mon … Sun] as YYYY-MM-DD
  console.log(`Generating habits for week: ${weekDates[0]} to ${weekDates[6]}`);

  // Three upfront queries instead of one per (habit, day)
  const [entries, existingMap, pendingNames] = await Promise.all([
    querySchedule(env),
    fetchHabitsForWeek(weekDates, env),
    fetchPendingPersistentNames(env),
  ]);
  console.log(`Active entries: ${entries.length}, existing this week: ${existingMap.size}, pending persistent: ${pendingNames.size}`);

  const log = [];

  // Phase 1: figure out which (entry, date) pairs run this batch — no timing yet.
  const jobs = [];
  for (const entry of entries) {
    const name = entry.properties?.Name?.title?.[0]?.plain_text;
    if (!name) continue;

    const days          = (entry.properties?.Days?.multi_select || []).map(o => o.name);
    const explicitStart = entry.properties?.["Start Time"]?.number ?? null;
    const duration      = entry.properties?.["Duration"]?.number   ?? null;
    const partOfDay     = entry.properties?.["Part of Day"]?.select?.name ?? null;
    const sequence      = entry.properties?.["Sequence"]?.select?.name ?? null;
    const persistent    = entry.properties?.Persistent?.checkbox   ?? false;
    const topicRelation = entry.properties?.["Topic(s)"]?.relation || [];
    const icon          = entry.icon || null;

    if (persistent) {
      if (pendingNames.has(name)) {
        log.push(`skip [persistent pending]: ${name}`);
        continue;
      }
      const indices = days.map(d => DAY_INDEX[d]).filter(i => i !== undefined && batchDays.has(i)).sort((a, b) => a - b);
      if (indices.length === 0) continue;
      jobs.push({ name, date: weekDates[indices[0]], persistent: true, topicRelation, icon, explicitStart, duration, partOfDay, sequence });
    } else {
      for (const abbrev of days) {
        const idx = DAY_INDEX[abbrev];
        if (idx === undefined || !batchDays.has(idx)) continue;
        jobs.push({ name, date: weekDates[idx], persistent: false, topicRelation, icon, explicitStart, duration, partOfDay, sequence });
      }
    }
  }

  // Phase 2: stack Part-of-Day-only jobs into 30-min slots within each day+bucket group.
  assignPartOfDaySlots(jobs);

  // Phase 3: resolve final start/end per job (explicit Start Time always wins) and write to Notion.
  for (const job of jobs) {
    const startTime = job.explicitStart ?? job.slotStart ?? null;
    const endTime   = job.explicitStart != null
      ? job.explicitStart + (job.duration ?? DEFAULT_DURATION_HOURS)
      : job.slotEnd ?? null;
    const eventTime = buildScheduledDate(job.date, startTime, endTime);

    if (job.persistent) {
      await createHabitsPage(job.name, job.date, eventTime, job.topicRelation, job.icon, env);
      log.push(`created [persistent]: ${job.name} on ${job.date}`);
      continue;
    }

    const existing = existingMap.get(`${job.name}|${job.date}`);
    if (existing) {
      const existingStart = existing.properties?.["Event Time"]?.date?.start;
      const existingDate  = existing.properties?.Date?.date?.start;
      if (existingStart && existingStart.includes("T")) {
        // Has explicit time — preserve Event Time; backfill Date if missing
        if (!existingDate) {
          await backfillDate(existing.id, job.date, env);
          log.push(`backfilled date: ${job.name} on ${job.date}`);
        } else {
          log.push(`skip [has time]: ${job.name} on ${job.date}`);
        }
      } else {
        await updateHabitsDate(existing.id, job.date, eventTime, env);
        log.push(`updated: ${job.name} on ${job.date}`);
      }
    } else {
      await createHabitsPage(job.name, job.date, eventTime, job.topicRelation, job.icon, env);
      log.push(`created: ${job.name} on ${job.date}`);
    }
  }

  return log;
}

// Non-persistent habit pages with no Event Time are orphaned (Notion's own recurring
// templates, or interrupted generation runs). Archives them so they don't clutter search.
// Persistent habits (Finances, Laundry) never get an Event Time by design, so they're
// left alone — otherwise every batch would "rediscover" them and loop forever.
const PERSISTENT_HABITS = new Set(["Finances", "Laundry"]);

// Free-plan invocations cap at 50 subrequests; one query + up to this many archive
// PATCHes stays comfortably under that, leaving room for the continuation fetch.
const CLEANUP_BATCH_SIZE = 40;

async function cleanupOrphanedHabits(env, origin, ctx) {
  const res = await fetch(`https://api.notion.com/v1/data_sources/${HABITS_DS_ID}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: { property: "Event Time", date: { is_empty: true } },
      page_size: CLEANUP_BATCH_SIZE,
    }),
  });
  if (!res.ok) throw new Error(`cleanup query ${res.status}`);
  const { results: pages, has_more } = await res.json();

  const log = [];
  let archivedCount = 0;
  for (const page of pages) {
    const name = page.properties?.Name?.title?.[0]?.plain_text || "";
    if (PERSISTENT_HABITS.has(name)) { log.push(`keep [persistent]: ${name}`); continue; }
    const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method: "PATCH",
      headers: notionHeaders(env),
      body: JSON.stringify({ in_trash: true }),
    });
    if (r.ok) archivedCount++;
    log.push(r.ok ? `archived: ${name}` : `failed: ${name} ${r.status} ${await r.text()}`);
  }

  // Keep going only if this batch made progress — otherwise everything left matching
  // the filter is persistent-habit pages, which will never clear and would loop forever.
  if (has_more && archivedCount > 0) {
    ctx.waitUntil(fetch(`${origin}/cleanup`).catch(e => console.error("cleanup continue:", e)));
    log.push("continuing…");
  }

  return log;
}
