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

// Serve static and ensure "/" serves epic.html
app.use(express.static(__dirname, { extensions: ["html"] }));
// app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "epic.html")));

app.get("/api/health", (_req, res) => res.status(200).send("ok"));

app.post("/api/analyze", async (req, res) => {
  try {
    const { epic, stories, tickets, intents } = req.body;

    const sList = (stories || []).map(s => `- ${s.key}: ${s.summary} [intent=${s.intent||"—"}]`).join("\n");
    const tList = (tickets || []).slice(0, 50).map(t => `- (${t.intent}) ${t.subject}: ${t.description}`).join("\n");

    const sys = `You are an analyst. Score how well the epic and its stories address the selected intents across the provided tickets.
Return JSON with fields:
- score (0..1) overall alignment (not per-story)
- summary (1-2 sentences, plain text)
- suggestions (array of 3-6 crisp improvement items)
- likelihoodPercent (0..100) = estimated probability that these stories will achieve a 40% reduction in customer support volume from baseline (ignore timeline).`;

    const usr = `Epic: ${epic?.name || "Untitled"}
Description: ${epic?.description || "(none)"}

Selected intents: ${Array.isArray(intents) ? intents.join(", ") : ""}

Stories:
${sList}

Tickets (sample across selected intents):
${tList}

Instructions:
1) Consider coverage of selected intents, specificity of stories, and severity/themes in tickets.
2) Return score (0..1), short summary, list of suggestions, and likelihoodPercent (0..100) for the 40% reduction KPI.`;

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
    let parsed = { score: null, summary: "", suggestions: [], likelihoodPercent: null };
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch {}

    // Fallbacks
    // Alignment score fallback
    let score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : null;
    if (score === null) {
      const intentsCovered = new Set((stories || []).map(s => (s.intent || "").trim()).filter(Boolean));
      const relevant = (tickets || []).filter(t => (intents || []).includes(t.intent));
      const covered = relevant.filter(t => intentsCovered.has(t.intent)).length;
      score = relevant.length ? covered / relevant.length : 0;
    }
    // Likelihood fallback
    let likelihoodPercent = typeof parsed.likelihoodPercent === "number" ? Math.max(0, Math.min(100, Math.round(parsed.likelihoodPercent))) : null;
    if (likelihoodPercent === null) {
      const intentsCovered = new Set((stories || []).map(s => (s.intent || "").trim()).filter(Boolean));
      const coveredCount = (intents || []).filter(i => intentsCovered.has(i)).length;
      const coverage = (intents && intents.length) ? coveredCount / intents.length : 0;
      likelihoodPercent = Math.round(Math.max(0, Math.min(1, 0.7*score + 0.3*coverage)) * 100);
    }

    res.json({
      score,
      summary: parsed.summary || "LLM returned no summary.",
      suggestions: Array.isArray(parsed.suggestions) && parsed.suggestions.length ? parsed.suggestions : [
        "Add at least one story explicitly mapped to each selected intent.",
        "Tighten acceptance criteria to mirror ticket language and edge cases.",
        "Add UI copy improvements for error states called out in tickets."
      ],
      likelihoodPercent
    });
  } catch (e) {
    res.status(500).json({ error: "Unhandled error", detail: String(e) });
  }
});

app.post("/api/suggest_stories", async (req, res) => {
  try {
    const { epic, intents, existingStories = [], tickets = [] } = req.body;

    // Trim & sanitize prompt to avoid token bloat
    const maxStories = 20;
    const maxTickets = 20;
    const eList = existingStories.slice(0, maxStories)
      .map(s => `- ${s.key}: ${String(s.summary || "").slice(0, 200)} [intent=${s.intent || "—"}]`)
      .join("\n");
    const tList = tickets.slice(0, maxTickets)
      .map(t => `- (${t.intent}) ${String(t.subject || "").slice(0,120)}: ${String(t.description || "").slice(0,240)}`)
      .join("\n");

    const sys = `You are a product manager generating user stories.
Return JSON with "stories": exactly 3 objects:
- summary (concise; start with an infinitive verb or "As a ... I want ...")
- intent (one of: ${Array.isArray(intents) ? intents.join(", ") : ""})
- storyPoints (integer 1..5)`;

    const usr = `Epic: ${epic?.name || "Untitled"}
Description: ${epic?.description || "(none)"}

Selected intents: ${Array.isArray(intents) ? intents.join(", ") : ""}

Existing stories:
${eList}

Representative tickets:
${tList}

Goal: Propose 3 *new* stories that most increase alignment for these intents while avoiding duplicates.`

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // Small retry helper for 429/5xx
    const callOpenAI = async () => {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.3,
          max_tokens: 350,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: sys }, { role: "user", content: usr }]
        })
      });
      return r;
    };

    let r = await callOpenAI();
    if (!r.ok && (r.status === 429 || r.status >= 500)) {
      // brief backoff then retry once
      await new Promise(d => setTimeout(d, 600));
      r = await callOpenAI();
    }

    if (!r.ok) {
      const tx = await r.text();
      console.error("suggest_stories upstream error:", r.status, tx);
      return res.status(502).json({ error: "OpenAI error", status: r.status, detail: tx.slice(0, 1200) });
    }

    const data = await r.json();
    let parsed = { stories: [] };
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch (e) {
      console.error("suggest_stories JSON parse fail:", e, data);
    }

    const stories = Array.isArray(parsed.stories)
      ? parsed.stories.slice(0,3).map(s => ({
          summary: String(s.summary || "").slice(0, 250),
          intent: String(s.intent || intents?.[0] || ""),
          storyPoints: Math.max(1, Math.min(5, parseInt(s.storyPoints || 3, 10) || 3))
        }))
      : [];

    return res.json({ stories });
  } catch (e) {
    console.error("suggest_stories handler error:", e);
    res.status(500).json({ error: "Unhandled error", detail: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Epic Viewer running on http://localhost:${port}`));
