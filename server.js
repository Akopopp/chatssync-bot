import express from "express";
import axios from "axios";
import fs from "fs";
import { initDb, seedFlowIfEmpty, getPublishedFlow, getSession, saveSession } from "./db.js";

const PORT = process.env.PORT || 3000;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const BOT_TOKEN = process.env.CHATWOOT_BOT_TOKEN;

const seedFlow = JSON.parse(fs.readFileSync("./flow.json", "utf-8"));

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("ChatsSync bot engine is running"));

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
// Conversation ko "open" karo taake inbox mein dikhe (agent ko visible)
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

    // BUTTON CLICK (message_updated + submitted_values)
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

    // Sirf customer ke incoming text par react karo (agent/outgoing/template ignore)
    if (event.event !== "message_created") return;
    if (event.message_type !== "incoming") return;
    const text = (event.content || "").trim();
    console.log(`Incoming text: "${text}" (conv ${conversationId})`);

    const isRepublished =
      session && session.flow_published_at &&
      new Date(session.flow_published_at).getTime() < new Date(flowPublishedAt).getTime();

    // Naya customer YA republish -> flow ek baar trigger + conversation ko inbox mein "open" karo
    if (!session || isRepublished) {
      await openConversation(accountId, conversationId); // chat foran inbox mein dikhe
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

    // buttons ka intezaar tha magr text aaya, ya flow khatam -> bot khamosh (agent baat kar sakta)
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
