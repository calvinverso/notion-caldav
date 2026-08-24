// One-time setup: adds properties to the Schedule database.
// Run with: NOTION_TOKEN=xxx node setup-schedule-db.js
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const SCHEDULE_DB_ID = "3b2835b175d88095b5fcd4155302ecda";
const TOPICS_DB_ID = "0e715eba780940de8345c7d7c38329e6";

if (!NOTION_TOKEN) {
  console.error("Set NOTION_TOKEN env var first.");
  process.exit(1);
}

const res = await fetch(`https://api.notion.com/v1/databases/${SCHEDULE_DB_ID}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2026-03-11",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    properties: {
      Days: {
        multi_select: {
          options: [
            { name: "Monday",    color: "blue"   },
            { name: "Tuesday",   color: "green"  },
            { name: "Wednesday", color: "yellow" },
            { name: "Thursday",  color: "orange" },
            { name: "Friday",    color: "red"    },
            { name: "Saturday",  color: "purple" },
            { name: "Sunday",    color: "pink"   },
          ],
        },
      },
      Start:      { number: { format: "number" } },
      End:        { number: { format: "number" } },
      Active:     { checkbox: {} },
      Persistent: { checkbox: {} },
      Topic:      { relation: { database_id: TOPICS_DB_ID } },
    },
  }),
});

const data = await res.json();
if (!res.ok) {
  console.error("Failed:", JSON.stringify(data, null, 2));
  process.exit(1);
}
console.log("Done. Properties on Schedule DB:", Object.keys(data.properties).join(", "));
