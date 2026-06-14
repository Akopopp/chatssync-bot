import express from "express";
import axios from "axios";
import fs from "fs";

// ---------- CONFIG (Coolify env vars se) ----------
const PORT = process.env.PORT || 3000;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const BOT_TOKEN = process.env.CHATWOOT_BOT_TOKEN;

// ---------- Flow load karo ----------
const flow = JSON.parse(fs.readFileSync("./flow.json", "utf-8"));

const app = express();
app.use(express.json());

// In-memory sessions: key = "accountId:conversationId" -> { nodeId, awaiting, variables }
// NOTE: ye redeploy/restart par reset hota hai. Phase 8 mein Postgres se persist karenge.
const sessions = new Map();
const key = (a, c) => `${a}:${c}`;

app.get("/", (req, res) => res.send("ChatsSync bot engine is running ✅"));

// ---------- Chatwoot API helpers ----------
async function apiPost(path, body) {
  return axios.post(`${CHATWOOT_BASE_URL}${path}`, body, {
    headers: { api_access_token: BOT_TOKEN },
  });
}

async function sendText(accountId, conversationId, text) {
  try {
    await apiPost(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      { content: text, message_type: "outgoing" }
    );
  } catch (e) {
    console.error("sendText error:", e.response?.data || e.message);
  }
}

async function sendButtons(accountId, conversationId, text, buttons) {
  try {
    await apiPost(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        content: text,
        message_type: "outgoing",
        content_type: "input_select",
        content_attributes: {
          items: buttons.map((b) => ({ title: b.title, value: b.title })),
        },
      }
    );
  } catch (e) {
    console.error("sendButtons error:", e.response?.data || e.message);
  }
}

async function handover(accountId, conversationId) {
  // Conversation ko "open" kar do taake human agent le sake
  try {
    await apiPost(
      `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`,
      { status: "open" }
    );
  } catch (e) {
    console.error("handover error:", e.response?.data || e.message);
  }
}

// ---------- Flow runner: nodes chalao jab tak koi "wait" na aaye ----------
async function runFlow(accountId, conversationId, session) {
  const k = key(accountId, conversationId);
  for (let i = 0; i < 50; i++) {
    const node = flow.nodes[session.nodeId];
    if (!node) { sessions.delete(k); return; }

    if (node.type === "text") {
      await sendText(accountId, conversationId, node.text);
      if (node.next) { session.nodeId = node.next; continue; }
      sessions.delete(k);
      return;
    }

    if (node.type === "buttons") {
      await sendButtons(accountId, conversationId, node.text, node.buttons);
      session.awaiting = "buttons"; // user ke choice ka intezaar
      return;
    }

    if (node.type === "question") {
      await sendText(accountId, conversationId, node.text);
      session.awaiting = "question"; // user ke jawab ka intezaar
      return;
    }

    if (node.type === "handover") {
      if (node.text) await sendText(accountId, conversationId, node.text);
      await handover(accountId, conversationId);
      sessions.delete(k);
      return;
    }

    // unknown node
    sessions.delete(k);
    return;
  }
}

// ---------- WEBHOOK ----------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Chatwoot ko turant OK

  const event = req.body;
  console.log("FULL EVENT:", JSON.stringify({ event: event.event, type: event.message_type, content: event.content, content_type: event.content_type }));
  if (event.event !== "message_created") return;
  if (event.message_type !== "incoming") return;

  const accountId = event.account?.id;
  const conversationId = event.conversation?.id;
  const text = (event.content || "").trim();
  if (!accountId || !conversationId) return;

  const lower = text.toLowerCase();
  const k = key(accountId, conversationId);
  let session = sessions.get(k);

  console.log(`Incoming: "${text}" (conv ${conversationId})`);

  // Reset keywords ya nayi conversation -> flow shuru
  if (!session || ["menu", "restart", "start", "hi", "hello"].includes(lower)) {
    session = { nodeId: flow.start, awaiting: null, variables: {} };
    sessions.set(k, session);
    await runFlow(accountId, conversationId, session);
    return;
  }

  const node = flow.nodes[session.nodeId];
  if (!node) { sessions.delete(k); return; }

  // Buttons ka intezaar
  if (session.awaiting === "buttons") {
    const btn = node.buttons.find(
      (b) => b.title.toLowerCase() === lower
    );
    if (!btn) {
      await sendText(accountId, conversationId, "Upar diye options mein se ek chunein 🙂");
      await sendButtons(accountId, conversationId, node.text, node.buttons);
      return;
    }
    session.awaiting = null;
    session.nodeId = btn.next;
    await runFlow(accountId, conversationId, session);
    return;
  }

  // Question ka intezaar
  if (session.awaiting === "question") {
    if (node.save_as) session.variables[node.save_as] = text;
    session.awaiting = null;
    session.nodeId = node.next;
    await runFlow(accountId, conversationId, session);
    return;
  }

  // fallback -> dobara shuru
  session = { nodeId: flow.start, awaiting: null, variables: {} };
  sessions.set(k, session);
  await runFlow(accountId, conversationId, session);
});

app.listen(PORT, () => console.log(`ChatsSync bot engine listening on port ${PORT}`));
