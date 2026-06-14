import express from "express";
import axios from "axios";

// ---------- CONFIG (Coolify env vars se aayega) ----------
const PORT = process.env.PORT || 3000;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL; // e.g. http://chatwoot-xxx.sslip.io
const BOT_TOKEN = process.env.CHATWOOT_BOT_TOKEN;        // Agent Bot ka access token

const app = express();
app.use(express.json());

// ---------- Health check (Coolify isse "healthy" check karega) ----------
app.get("/", (req, res) => {
  res.send("ChatsSync bot engine is running ✅");
});

// ---------- Chatwoot ko reply bhejne wala function ----------
async function sendReply(accountId, conversationId, message) {
  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  try {
    await axios.post(
      url,
      { content: message, message_type: "outgoing" },
      { headers: { api_access_token: BOT_TOKEN } }
    );
    console.log(`Reply sent to conversation ${conversationId}: "${message}"`);
  } catch (err) {
    console.error("Failed to send reply:", err.response?.data || err.message);
  }
}

// ---------- WEBHOOK: Chatwoot yahan har message bhejega ----------
app.post("/webhook", async (req, res) => {
  // Pehle Chatwoot ko turant "OK" bol do (warna woh timeout karega)
  res.sendStatus(200);

  const event = req.body;

  // Sirf naye incoming messages par react karo
  // (event "message_created", message_type "incoming" = customer ka message)
  if (event.event !== "message_created") return;
  if (event.message_type !== "incoming") return;

  const accountId = event.account?.id;
  const conversationId = event.conversation?.id;
  const userText = (event.content || "").trim().toLowerCase();

  console.log(`Incoming message: "${userText}" (conversation ${conversationId})`);

  if (!accountId || !conversationId) return;

  // ---------- SIMPLE BOT LOGIC (Phase 3 test) ----------
  // Aage hum yahan poora flow engine lagayenge.
  let reply;
  if (userText === "hi" || userText === "hello" || userText === "hey") {
    reply = "Hello 👋 Welcome to ChatsSync! Main aapka chatbot hoon.";
  } else if (userText.includes("price") || userText.includes("pricing")) {
    reply = "Hamare pricing plans ke liye 'plans' likhein.";
  } else {
    reply = `Aapne kaha: "${event.content}". Main abhi seekh raha hoon 🙂`;
  }

  await sendReply(accountId, conversationId, reply);
});

app.listen(PORT, () => {
  console.log(`ChatsSync bot engine listening on port ${PORT}`);
});
