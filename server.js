import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import multer from "multer";
import FormData from "form-data";
import {
  initDb, seedFlowIfEmpty, getPublishedFlowForInbox, getSession, saveSession,
  listFlows, createFlow, getFlowById, saveFlowById, publishFlowById, unpublishFlowById, deleteFlowById, assignInbox,
  addMedia, listMedia, getMedia, deleteMedia,
} from "./db.js";

const PORT = process.env.PORT || 3000;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const BOT_TOKEN = process.env.CHATWOOT_BOT_TOKEN;
const ADMIN_TOKEN = process.env.CHATWOOT_API_TOKEN;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const seedFlow = JSON.parse(fs.readFileSync("./flow.json", "utf-8"));

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// uploaded files publicly serve
app.use("/uploads", express.static(UPLOAD_DIR));

app.get("/", (req, res) => res.send("ChatsSync bot engine is running"));
const parseDef = (d) => (typeof d === "string" ? JSON.parse(d) : d);

// ===== MEDIA / GALLERY =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => { const ext = path.extname(file.originalname || ""); cb(null, "m" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext); },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB
function mediaType(mime) { if (!mime) return "document"; if (mime.startsWith("image/")) return "image"; if (mime.startsWith("video/")) return "video"; if (mime.startsWith("audio/")) return "audio"; return "document"; }
function fileUrl(req, filename) { return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/uploads/${filename}` : `${req.protocol}://${req.get("host")}/uploads/${filename}`; }

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const accountId = parseInt(req.body.account_id || req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!req.file) return res.status(400).json({ error: "file required" });
    const url = fileUrl(req, req.file.filename);
    const type = mediaType(req.file.mimetype);
    const row = await addMedia(accountId, req.file.filename, req.file.originalname, url, type, req.file.size);
    res.json({ ok: true, media: { id: row.id, url: row.url, type: row.type, original_name: row.original_name, size: row.size } });
  } catch (e) { console.error("upload", e.message); res.status(500).json({ error: e.message }); }
});
app.get("/api/media", async (req, res) => {
  try { const accountId = parseInt(req.query.account_id, 10); if (!accountId) return res.status(400).json({ error: "account_id required" }); res.json({ media: await listMedia(accountId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/media/:id", async (req, res) => {
  try { const m = await getMedia(parseInt(req.params.id, 10)); if (m) { try { fs.unlinkSync(path.join(UPLOAD_DIR, m.filename)); } catch {} await deleteMedia(m.id); } res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== MULTI-FLOW API =====
app.get("/api/flows", async (req, res) => { try { const a = parseInt(req.query.account_id, 10); if (!a) return res.status(400).json({ error: "account_id required" }); res.json({ flows: await listFlows(a) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows", async (req, res) => { try { const { account_id, name, inbox_id } = req.body || {}; const a = parseInt(account_id, 10); if (!a) return res.status(400).json({ error: "account_id required" }); const row = await createFlow(a, name, inbox_id != null ? parseInt(inbox_id, 10) : null); res.json({ ok: true, flow: { id: row.id, name: row.name, status: row.status, inbox_id: row.inbox_id } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/flows/:id", async (req, res) => { try { const row = await getFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); res.json({ flow: { id: row.id, name: row.name, status: row.status, inbox_id: row.inbox_id, definition: parseDef(row.definition) } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put("/api/flows/:id", async (req, res) => { try { const { name, definition } = req.body || {}; if (!definition || !definition.nodes) return res.status(400).json({ error: "definition required" }); const row = await saveFlowById(parseInt(req.params.id, 10), name, definition); if (!row) return res.status(404).json({ error: "not found" }); res.json({ ok: true, flow: { id: row.id, name: row.name, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/publish", async (req, res) => { try { const row = await publishFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); res.json({ ok: true, flow: { id: row.id, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/unpublish", async (req, res) => { try { const row = await unpublishFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); res.json({ ok: true, flow: { id: row.id, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete("/api/flows/:id", async (req, res) => { try { await deleteFlowById(parseInt(req.params.id, 10)); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/assign-inbox", async (req, res) => { try { const inboxId = (req.body || {}).inbox_id; const row = await assignInbox(parseInt(req.params.id, 10), inboxId != null ? parseInt(inboxId, 10) : null); if (!row) return res.status(404).json({ error: "not found" }); res.json({ ok: true, flow: { id: row.id, inbox_id: row.inbox_id } }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get("/api/inboxes", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!ADMIN_TOKEN) return res.status(400).json({ error: "CHATWOOT_API_TOKEN not set" });
    const r = await axios.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/inboxes`, { headers: { api_access_token: ADMIN_TOKEN } });
    res.json({ inboxes: (r.data?.payload || []).map((i) => ({ id: i.id, name: i.name, channel_type: i.channel_type })) });
  } catch (e) { console.error("GET /api/inboxes", e.response?.data || e.message); res.status(500).json({ error: e.message }); }
});

// labels list (for Update Tag node dropdown in the builder)
app.get("/api/labels", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!ADMIN_TOKEN) return res.json({ labels: [] });
    const r = await axios.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/labels`, { headers: { api_access_token: ADMIN_TOKEN } });
    res.json({ labels: (r.data?.payload || []).map((l) => l.title) });
  } catch (e) { console.error("GET /api/labels", e.response?.data || e.message); res.json({ labels: [] }); }
});

// ===================== BOT ENGINE =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function apiPost(path2, body) { return axios.post(`${CHATWOOT_BASE_URL}${path2}`, body, { headers: { api_access_token: BOT_TOKEN } }); }
async function sendText(a, c, text) { if (!text) return; try { await apiPost(`/api/v1/accounts/${a}/conversations/${c}/messages`, { content: text, message_type: "outgoing" }); } catch (e) { console.error("sendText", e.response?.data || e.message); } }
// Chatwoot turns input_select into WhatsApp interactive buttons (<=3 items) or a list (>3 items)
async function sendOptions(a, c, text, titles) { try { await apiPost(`/api/v1/accounts/${a}/conversations/${c}/messages`, { content: text || " ", message_type: "outgoing", content_type: "input_select", content_attributes: { items: (titles || []).map((t) => ({ title: t, value: t })) } }); } catch (e) { console.error("sendOptions", e.response?.data || e.message); } }
async function openConversation(a, c) { try { await apiPost(`/api/v1/accounts/${a}/conversations/${c}/toggle_status`, { status: "open" }); } catch (e) { console.error("openConversation", e.response?.data || e.message); } }

// Update Tag -> merge with existing labels (does not remove current ones)
async function addLabels(a, c, labels) {
  try {
    if (!labels || !labels.length) return;
    let cur = [];
    try { const r = await axios.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/labels`, { headers: { api_access_token: ADMIN_TOKEN } }); cur = r.data?.payload || []; } catch {}
    const merged = [...new Set([...cur, ...labels])];
    await axios.post(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/labels`, { labels: merged }, { headers: { api_access_token: ADMIN_TOKEN } });
  } catch (e) { console.error("addLabels", e.response?.data || e.message); }
}

function ctaText(node) {
  let out = node.body || "";
  if (node.url) out += (out ? "\n\n" : "") + (node.display ? node.display + ": " : "") + node.url;
  if (node.footer) out += "\n\n" + node.footer;
  return out;
}

function evalCondition(node, vars) {
  const subst = (str) => String(str == null ? "" : str).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  let a = node.first ? subst(node.first) : (vars.last_message || "");
  const b = subst(node.second);
  const al = a.toLowerCase().trim(), bl = b.toLowerCase().trim();
  switch (node.operator || "equals") {
    case "equals": return al === bl;
    case "not_equals": return al !== bl;
    case "contains": return al.includes(bl);
    case "not_contains": return !al.includes(bl);
    case "starts_with": return al.startsWith(bl);
    case "ends_with": return al.endsWith(bl);
    case "greater_than": return parseFloat(a) > parseFloat(b);
    case "less_than": return parseFloat(a) < parseFloat(b);
    case "is_email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.trim());
    case "is_phone": return /^[+]?[\d\s\-()]{7,}$/.test(a.trim());
    case "regex": try { return new RegExp(b, "i").test(a); } catch { return false; }
    default: return false;
  }
}

// Map a file extension to a MIME type (Chatwoot needs the content type for attachments)
function extToMime(name) {
  const ext = (String(name).split("?")[0].split(".").pop() || "").toLowerCase();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", pdf: "application/pdf" };
  return map[ext] || "application/octet-stream";
}
// Send a media file to Chatwoot as a real attachment (multipart/form-data, attachments[])
async function sendMedia(a, c, url, caption) {
  try {
    if (!url) return;
    const clean = String(url).split("?")[0];
    const baseName = decodeURIComponent(clean.split("/uploads/")[1] || clean.split("/").pop() || "file");
    const localPath = path.join(UPLOAD_DIR, path.basename(baseName));
    let buffer;
    if (clean.includes("/uploads/") && fs.existsSync(localPath)) {
      buffer = fs.readFileSync(localPath); // gallery file lives on our own disk
    } else {
      const resp = await axios.get(url, { responseType: "arraybuffer", maxContentLength: Infinity, maxBodyLength: Infinity }); // external / pasted link
      buffer = Buffer.from(resp.data);
    }
    const form = new FormData();
    if (caption) form.append("content", caption);
    form.append("message_type", "outgoing");
    form.append("attachments[]", buffer, { filename: path.basename(baseName), contentType: extToMime(baseName) });
    await axios.post(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/messages`, form, { headers: { api_access_token: BOT_TOKEN, ...form.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity });
  } catch (e) { console.error("sendMedia", e.response?.data || e.message); }
}

function toSession(row, fpa) { return { nodeId: row.node_id, awaiting: row.awaiting, variables: typeof row.variables === "string" ? JSON.parse(row.variables) : (row.variables || {}), flowPublishedAt: row.flow_published_at ? new Date(row.flow_published_at).toISOString() : fpa }; }

async function runFlow(a, c, s, def) {
  for (let i = 0; i < 100; i++) {
    const node = def.nodes[s.nodeId];
    if (!node) { s.awaiting = null; s.nodeId = null; return; }

    if (node.type === "text") { await sendText(a, c, node.text); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "media") { await sendMedia(a, c, node.url, node.caption); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "cta") { await sendText(a, c, ctaText(node)); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "tag") { await addLabels(a, c, node.labels || []); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "delay") { const secs = Math.max(0, Math.min(parseInt(node.seconds, 10) || 0, 300)); if (secs > 0) await sleep(secs * 1000); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "condition") { const ok = evalCondition(node, s.variables || {}); s.nodeId = ok ? (node.next_true || null) : (node.next_false || null); if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "buttons") { await sendOptions(a, c, node.text, (node.buttons || []).map((b) => b.title)); s.awaiting = "buttons"; return; }

    if (node.type === "list") { await sendOptions(a, c, node.body, (node.rows || []).map((r) => r.title)); s.awaiting = "list"; return; }

    if (node.type === "question") { await sendText(a, c, node.text); s.awaiting = "question"; return; }

    if (node.type === "handover") { if (node.text) await sendText(a, c, node.text); await openConversation(a, c); s.awaiting = null; s.nodeId = null; return; }

    s.awaiting = null; s.nodeId = null; return;
  }
}

// find which "next" an incoming reply (button/list selection) maps to
function matchChoice(node, choice) {
  const t = (choice || "").toLowerCase().trim();
  if (!node) return null;
  if (node.type === "buttons") { const b = (node.buttons || []).find((x) => (x.title || "").toLowerCase().trim() === t); return b ? (b.next || null) : null; }
  if (node.type === "list") { const r = (node.rows || []).find((x) => (x.title || "").toLowerCase().trim() === t); return r ? (r.next || null) : null; }
  return null;
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    const accountId = event.account?.id; const conversationId = event.conversation?.id;
    const inboxId = event.conversation?.inbox_id ?? event.inbox?.id ?? event.conversation?.inbox?.id ?? null;
    if (!accountId || !conversationId) return;
    const flowRow = await getPublishedFlowForInbox(accountId, inboxId);
    if (!flowRow) return;
    const def = parseDef(flowRow.definition); if (!def.start) return;
    const flowPublishedAt = new Date(flowRow.published_at).toISOString();
    const session = await getSession(accountId, conversationId);

    // --- Website widget: button/list click arrives as message_updated + submitted_values ---
    const submitted = event.content_attributes?.submitted_values;
    if (event.event === "message_updated" && Array.isArray(submitted) && submitted.length > 0) {
      const choice = (submitted[0].value || submitted[0].title || "").trim();
      if (session && (session.awaiting === "buttons" || session.awaiting === "list") && session.node_id) {
        const next = matchChoice(def.nodes[session.node_id], choice);
        if (next !== null || true) {
          const s = toSession(session, flowPublishedAt);
          s.variables.last_message = choice;
          s.nodeId = next; s.awaiting = null;
          await runFlow(accountId, conversationId, s, def);
          await saveSession(accountId, conversationId, s);
        }
      }
      return;
    }

    if (event.event !== "message_created") return;
    if (event.message_type !== "incoming") return;
    const text = (event.content || "").trim();

    const isRepublished = session && session.flow_published_at && new Date(session.flow_published_at).getTime() < new Date(flowPublishedAt).getTime();

    // No session yet, or flow was re-published -> (re)start the flow
    if (!session || isRepublished) {
      await openConversation(accountId, conversationId);
      const s = { nodeId: def.start, awaiting: null, variables: { last_message: text }, flowPublishedAt };
      await runFlow(accountId, conversationId, s, def);
      await saveSession(accountId, conversationId, s);
      return;
    }

    // --- WhatsApp: a button/list reply comes back as a normal incoming text (the option's title) ---
    if (session.awaiting === "buttons" || session.awaiting === "list") {
      const next = matchChoice(def.nodes[session.node_id], text);
      const s = toSession(session, flowPublishedAt);
      s.variables.last_message = text;
      if (next !== null) { s.nodeId = next; s.awaiting = null; await runFlow(accountId, conversationId, s, def); await saveSession(accountId, conversationId, s); }
      else { await saveSession(accountId, conversationId, s); } // no match -> stay, keep last_message
      return;
    }

    if (session.awaiting === "question") {
      const node = def.nodes[session.node_id];
      const s = toSession(session, flowPublishedAt);
      s.variables.last_message = text;
      if (node?.save_as) s.variables[node.save_as] = text;
      s.awaiting = null; s.nodeId = node?.next || null;
      await runFlow(accountId, conversationId, s, def);
      await saveSession(accountId, conversationId, s);
      return;
    }

    // session exists but flow already finished -> stay quiet (agent may be handling it)
    return;
  } catch (e) { console.error("webhook error:", e.message); }
});

async function start() {
  await initDb();
  await seedFlowIfEmpty(3, seedFlow);
  app.listen(PORT, () => console.log(`ChatsSync bot engine listening on port ${PORT} | uploads: ${UPLOAD_DIR}`));
}
start().catch((e) => { console.error("Startup error:", e.message); process.exit(1); });
