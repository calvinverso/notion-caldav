const TOKEN = process.env.NOTION_TOKEN;
const DS_ID = "3b2835b1-75d8-808f-9b27-000b89048e78";

if (!TOKEN) {
  console.error("Set NOTION_TOKEN env var first.");
  process.exit(1);
}

// IDs from Topics database
const T = {
  Education:       "377835b1-75d8-80f1-bcd1-dc2b74921696",
  PersonalFinance: "1b9835b1-75d8-80db-94bd-ea2692a30018",
  Physique:        "1b9835b1-75d8-8023-a1c4-cac0445b93fc",
  Wellness:        "7c12bac1-2652-4cdb-bb43-8b51eb35eb5d",
  Spirituality:    "672840db-26b3-41f5-9495-38cf059bb394",
  Productivity:    "6c9d01f6-7536-47a9-bc8e-fd122546c82c",
  Taekwondo:       "1aa835b1-75d8-8023-bc71-e23ff30591eb",
};

// Exact topic mappings from existing Habits pages (+ best guesses for inactive ones)
const TOPICS = {
  "Cardio":            [T.Physique, T.Wellness],
  "Deep Work":         [T.Productivity],
  "Face Yoga":         [T.Physique],
  "Finances":          [T.PersonalFinance],
  "Laundry":           [],
  "Meditate":          [T.Wellness, T.Spirituality],
  "Read":              [T.Education],
  "Rosary":            [T.Spirituality],
  "Strength":          [T.Physique, T.Wellness],
  "Taekwondo":         [T.Taekwondo, T.Physique],
  "Vitamins":          [T.Physique, T.Wellness],
  "Yoga":              [T.Physique, T.Wellness, T.Spirituality],
  "Protein":           [T.Physique, T.Wellness],
  "Physique Progress": [T.Physique],
  "Jump Rope":         [T.Physique, T.Wellness],
  "Pilates":           [T.Physique, T.Wellness],
};

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": "2026-03-11",
  "Content-Type": "application/json",
};

const { results } = await (await fetch(`https://api.notion.com/v1/data_sources/${DS_ID}/query`, {
  method: "POST", headers: HEADERS, body: JSON.stringify({ page_size: 100 }),
})).json();

for (const page of results) {
  const name = page.properties?.Name?.title?.[0]?.plain_text;
  const topicIds = TOPICS[name];
  if (!topicIds || topicIds.length === 0) { console.log(`– ${name} (no topics)`); continue; }

  const patch = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
    method: "PATCH", headers: HEADERS,
    body: JSON.stringify({ properties: { "Topic(s)": { relation: topicIds.map(id => ({ id })) } } }),
  });
  const r = await patch.json();
  console.log(r.object === "page" ? `✓ ${name}` : `✗ ${name}: ${r.message}`);
}
