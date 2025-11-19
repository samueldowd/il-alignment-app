import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

// Serve the folder containing this file (epic.html + CSVs)
app.use(express.static(__dirname, { extensions: ["html"] }));

app.get("/api/health", (_req, res) => res.status(200).send("ok"));

app.post("/api/analyze", async (req, res) => {
  try {
    const { epic, stories, tickets, intents } = req.body;

    const sList = (stories || []).map(s => `- ${s.key}: ${s.summary} [intent=${s.intent||"—"}]`).join("\n");
    const tList = (tickets || []).slice(0, 50).map(t => `- (${t.intent}) ${t.subject}: ${t.description}`).join("\n");

    const sys = `You are an analyst. Score how well the epic and its stories address the selected intents across the provided tickets.
Return JSON with fields: score (0..1), summary (1-2 sentences), suggestions (array of 3-6 crisp items).`;

    const usr = `Epic: ${epic?.name || "Untitled"}
Description: ${epic?.description || "(none)"}

Selected intents: ${Array.isArray(intents) ? intents.join(", ") : ""}

Stories:
${sList}

Tickets (sample):
${tList}

Instructions:
1) Score 0..1 overall alignment (not per-story).
2) One-sentence summary.
3) Concrete suggestions to raise the score.`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: usr }]
      })
    });

    if (!r.ok) {
      const tx = await r.text();
      return res.status(502).json({ error: "OpenAI error", detail: tx });
    }
    const data = await r.json();
    let parsed = { score: null, summary: "", suggestions: [] };
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch {}

    let score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : null;
    if (score === null) {
      const intentsCovered = new Set((stories || []).map(s => (s.intent || "").trim()).filter(Boolean));
      const relevant = (tickets || []).filter(t => (intents || []).includes(t.intent));
      const covered = relevant.filter(t => intentsCovered.has(t.intent)).length;
      score = relevant.length ? covered / relevant.length : 0;
    }

    res.json({
      score,
      summary: parsed.summary || "LLM returned no summary.",
      suggestions: Array.isArray(parsed.suggestions) && parsed.suggestions.length ? parsed.suggestions : [
        "Add at least one story explicitly mapped to each selected intent.",
        "Tighten acceptance criteria to mirror ticket language and edge cases.",
        "Add UI copy improvements for error states called out in tickets."
      ]
    });
  } catch (e) {
    res.status(500).json({ error: "Unhandled error", detail: String(e) });
  }
});

app.post("/api/suggest_stories", async (req, res) => {
  try {
    const { epic, intents, existingStories, tickets } = req.body;

    const eList = (existingStories || []).map(s => `- ${s.key}: ${s.summary} [intent=${s.intent||"—"}]`).join("\n");
    const tList = (tickets || []).map(t => `- (${t.intent}) ${t.subject}: ${t.description}`).join("\n");

    const sys = `You are a product manager generating user stories.
Return JSON with "stories": an array of exactly 3 objects with fields:
- summary (concise, user-value oriented; start with an infinitive verb or "As a ... I want ...")
- intent (must be one of: ${Array.isArray(intents) ? intents.join(", ") : ""})
- storyPoints (integer 1..5)
Do not include keys or status.`;

    const usr = `Epic: ${epic?.name || "Untitled"}
Description: ${epic?.description || "(none)"}

Selected intents to focus on: ${Array.isArray(intents) ? intents.join(", ") : ""}

Existing stories:
${eList}

Representative tickets:
${tList}

Goal: Propose 3 new stories that would most increase alignment for these intents while avoiding duplication with existing stories.`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: usr }]
      })
    });

    if (!r.ok) {
      const tx = await r.text();
      return res.status(502).json({ error: "OpenAI error", detail: tx });
    }
    const data = await r.json();
    let parsed = { stories: [] };
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch {}

    const stories = Array.isArray(parsed.stories) ? parsed.stories.slice(0,3).map(s => ({
      summary: String(s.summary || "").slice(0, 250),
      intent: String(s.intent || intents?.[0] || ""),
      storyPoints: Math.max(1, Math.min(5, parseInt(s.storyPoints || 3, 10) || 3))
    })) : [];

    res.json({ stories });
  } catch (e) {
    res.status(500).json({ error: "Unhandled error", detail: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Epic Viewer running on http://localhost:${port}`));
