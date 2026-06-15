import express from "express";
import axios from "axios";
import fs from "fs";
import {
  initDb, seedFlowIfEmpty, getPublishedFlow, getSession, saveSession,
  getFlowForEditing, saveFlow, publishFlow,
} from "./db.js";

const PORT = process.env.PORT || 3000;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const BOT_TOKEN = process.env.CHATWOOT_BOT_TOKEN;

const seedFlow = JSON.parse(fs.readFileSync("./flow.json", "utf-8"));

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- CORS (builder alag origin se call karega) ----------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("ChatsSync bot engine is running"));

// =====================================================================
// FLOW API (builder ke liye)
// =====================================================================

// Flow load karo (builder open par)
app.get("/api/flow", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    const row = await getFlowForEditing(accountId);
    if (!row) return res.json({ flow: null });
    const definition = typeof row.definition === "string" ? JSON.parse(row.definition) : row.definition;
    res.json({
      flow: { id: row.id, name: row.name, status: row.status, definition },
    });
  } catch (e) {
    console.error("GET /api/flow error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Flow save karo (draft). Body: { account_id, name, definition, publish? }
app.post("/api/flow", async (req, res) => {
  try {
    const { account_id, name, definition, publish } = req.body || {};
    const accountId = parseInt(account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!definition || !definition.nodes || !definition.start) {
      return res.status(400).json({ error: "definition with start + nodes required" });
    }
    const row = await saveFlow(accountId, name, definition, !!publish);
    res.json({ ok: true, flow: { id: row.id, name: row.name, status: row.status } });
  } catch (e) {
    console.error("POST /api/flow error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Publish karo (reactivate trigger). Body: { account_id }
app.post("/api/flow/publish", async (req, res) => {
  try {
    const accountId = parseInt((req.body || {}).account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    const row = await publishFlow(accountId);
    if (!row) return res.status(404).json({ error: "no flow to publish" });
    res.json({ ok: true, flow: { id: row.id, status: row.status, published_at: row.published_at } });
  } catch (e) {
    console.error("POST /api/flow/publish error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// CHATWOOT BOT (engine) — wahi logic
// =====================================================================

async function apiPost(path, body) {
  return axios.post(`${CHATWOOT_BASE_URL}${path}`, body, {
    headers: { api_access_token: BOT_TOKEN },
  });
}
async function sendText(accountId, conversationId, text) {
  try {
    await apiPost(`/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      { content: text, message_type: "outgoing" });
  } catch (e) { console.error("sendText error:", e.response?.data || e.message); }
}
async function sendButtons(accountId, conversationId, text, buttons) {
  try {
    await apiPost(`/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
      content: text,
      message_type: "outgoing",
      content_type: "input_select",
      content_attributes: { items: buttons.map((b) => ({ title: b.title, value: b.title })) },
    });
  } catch (e) { console.error("sendButtons error:", e.response?.data || e.message); }
}
async function openConversation(accountId, conversationId) {
  try {
    await apiPost(`/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`,
      { status: "open" });
  } catch (e) { console.error("openConversation error:", e.response?.data || e.message); }
}

function toSession(row, flowPublishedAt) {
  return {
    nodeId: row.node_id,
    awaiting: row.awaiting,
    variables: typeof row.variables === "string" ? JSON.parse(row.variables) : (row.variables || {}),
    flowPublishedAt: row.flow_published_at ? new Date(row.flow_published_at).toISOString() : flowPublishedAt,
  };
}

async function runFlow(accountId, conversationId, s, def) {
  for (let i = 0; i < 50; i++) {
    const node = def.nodes[s.nodeId];
    if (!node) { s.awaiting = null; s.nodeId = null; return; }

    if (node.type === "text") {
      await sendText(accountId, conversationId, node.text);
      if (node.next) { s.nodeId = node.next; continue; }
      s.awaiting = null; s.nodeId = null; return;
    }
    if (node.type === "buttons") {
      await sendButtons(accountId, conversationId, node.text, node.buttons);
      s.awaiting = "buttons"; return;
    }
    if (node.type === "question") {
      await sendText(accountId, conversationId, node.text);
      s.awaiting = "question"; return;
    }
    if (node.type === "handover") {
      if (node.text) await sendText(accountId, conversationId, node.text);
      await openConversation(accountId, conversationId);
      s.awaiting = null; s.nodeId = null; return;
    }
    s.awaiting = null; s.nodeId = null; return;
  }
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    const accountId = event.account?.id;
    const conversationId = event.conversation?.id;
    if (!accountId || !conversationId) return;

    const flowRow = await getPublishedFlow(accountId);
    if (!flowRow) { console.log(`No published flow for account ${accountId}`); return; }
    const def = typeof flowRow.definition === "string" ? JSON.parse(flowRow.definition) : flowRow.definition;
    const flowPublishedAt = new Date(flowRow.published_at).toISOString();

    const session = await getSession(accountId, conversationId);

    const submitted = event.content_attributes?.submitted_values;
    if (event.event === "message_updated" && Array.isArray(submitted) && submitted.length > 0) {
      const choice = (submitted[0].value || submitted[0].title || "").trim();
      console.log(`Button click: "${choice}" (conv ${conversationId})`);
      if (session && session.awaiting === "buttons" && session.node_id) {
        const node = def.nodes[session.node_id];
        const btn = node?.buttons?.find((b) => b.title.toLowerCase() === choice.toLowerCase());
        if (btn) {
          const s = toSession(session, flowPublishedAt);
          s.nodeId = btn.next; s.awaiting = null;
          await runFlow(accountId, conversationId, s, def);
          await saveSession(accountId, conversationId, s);
        }
      }
      return;
    }

    if (event.event !== "message_created") return;
    if (event.message_type !== "incoming") return;
    const text = (event.content || "").trim();
    console.log(`Incoming text: "${text}" (conv ${conversationId})`);

    const isRepublished =
      session && session.flow_published_at &&
      new Date(session.flow_published_at).getTime() < new Date(flowPublishedAt).getTime();

    if (!session || isRepublished) {
      await openConversation(accountId, conversationId);
      const s = { nodeId: def.start, awaiting: null, variables: {}, flowPublishedAt };
      await runFlow(accountId, conversationId, s, def);
      await saveSession(accountId, conversationId, s);
      return;
    }

    if (session.awaiting === "question") {
      const node = def.nodes[session.node_id];
      const s = toSession(session, flowPublishedAt);
      if (node?.save_as) s.variables[node.save_as] = text;
      s.awaiting = null;
      s.nodeId = node?.next || null;
      await runFlow(accountId, conversationId, s, def);
      await saveSession(accountId, conversationId, s);
      return;
    }

    return;
  } catch (e) {
    console.error("webhook error:", e.message);
  }
});

async function start() {
  await initDb();
  await seedFlowIfEmpty(3, seedFlow);
  app.listen(PORT, () => console.log(`ChatsSync bot engine listening on port ${PORT}`));
}
start().catch((e) => { console.error("Startup error:", e.message); process.exit(1); });
