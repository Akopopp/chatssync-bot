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

// In-memory sessions: key = "accountId:conversationId" -> { nodeId, awaiting, variables, started }
// NOTE: redeploy par reset hota hai. Phase 8 mein Postgres se persist karenge.
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
    if (!node) { session.awaiting = null; session.nodeId = null; return; }

    if (node.type === "text") {
      await sendText(accountId, conversationId, node.text);
      if (node.next) { session.nodeId = node.next; continue; }
      session.awaiting = null; session.nodeId = null; // flow khatam (session rehne do = khamosh)
      return;
    }

    if (node.type === "buttons") {
      await sendButtons(accountId, conversationId, node.text, node.buttons);
      session.awaiting = "buttons";
      return;
    }

    if (node.type === "question") {
      await sendText(accountId, conversationId, node.text);
      session.awaiting = "question";
      return;
    }

    if (node.type === "handover") {
      if (node.text) await sendText(accountId, conversationId, node.text);
      await handover(accountId, conversationId);
      session.awaiting = null; session.nodeId = null;
      return;
    }

    session.awaiting = null; session.nodeId = null;
    return;
  }
}

// ---------- WEBHOOK ----------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Chatwoot ko turant OK

  const event = req.body;
  const accountId = event.account?.id;
  const conversationId = event.conversation?.id;
  if (!accountId || !conversationId) return;

  const k = key(accountId, conversationId);
  let session = sessions.get(k);

  // ===== CASE 1: BUTTON CLICK (message_updated + submitted_values) =====
  const submitted = event.content_attributes?.submitted_values;
  if (event.event === "message_updated" && Array.isArray(submitted) && submitted.length > 0) {
    const choice = (submitted[0].value || submitted[0].title || "").trim();
    console.log(`Button click: "${choice}" (conv ${conversationId})`);

    // Agar session button ka intezaar kar raha hai -> us choice par aage badho
    if (session && session.awaiting === "buttons") {
      const node = flow.nodes[session.nodeId];
      const btn = node?.buttons?.find(
        (b) => b.title.toLowerCase() === choice.toLowerCase()
      );
      if (btn) {
        session.awaiting = null;
        session.nodeId = btn.next;
        await runFlow(accountId, conversationId, session);
      }
    }
    return; // button click handle ho gaya
  }

  // ===== CASE 2: NORMAL INCOMING TEXT (message_created + incoming) =====
  if (event.event !== "message_created") return;
  if (event.message_type !== "incoming") return; // template/outgoing ignore

  const text = (event.content || "").trim();
  console.log(`Incoming text: "${text}" (conv ${conversationId})`);

  // Agar flow pehle se chal raha hai...
  if (session) {
    // Question ka intezaar -> jawab save karke aage
    if (session.awaiting === "question") {
      const node = flow.nodes[session.nodeId];
      if (node?.save_as) session.variables[node.save_as] = text;
      session.awaiting = null;
      session.nodeId = node?.next || null;
      await runFlow(accountId, conversationId, session);
      return;
    }
    // Buttons ka intezaar, magr user ne text likha -> KHAMOSH (kuch na karo)
    // Flow khatam ho chuka -> KHAMOSH
    return;
  }

  // ===== Naya customer, pehla message -> flow EK BAAR trigger karo =====
  session = { nodeId: flow.start, awaiting: null, variables: {}, started: true };
  sessions.set(k, session);
  await runFlow(accountId, conversationId, session);
});

app.listen(PORT, () => console.log(`ChatsSync bot engine listening on port ${PORT}`));
