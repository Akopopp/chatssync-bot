import express from "express";
import axios from "axios";
import http from "http";
import https from "https";
import fs from "fs";
import os from "os";
import path from "path";
import multer from "multer";
import FormData from "form-data";
import { spawn } from "child_process";
import crypto from "crypto";
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

// Optional native WhatsApp Cloud: set WA_TOKEN + WA_PHONE_NUMBER_ID to send REAL interactive
// (CTA url button, list row descriptions, native footer). If unset/any error -> falls back to Chatwoot.
const WA_TOKEN = process.env.WA_TOKEN || "";
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID || "";
const WA_VER = process.env.WA_GRAPH_VERSION || "v21.0";
const WA_ACCOUNT_ID = process.env.WA_ACCOUNT_ID || ""; // native only for this account (multi-account safety)
const waEnabled = !!(WA_TOKEN && WA_PHONE_ID);
// Optional: Chatwoot DB (read-only) -> auto-fetch each account's WhatsApp creds for native (true multi-account, no per-number env)
const CHATWOOT_DB_URL = process.env.CHATWOOT_DB_URL || "";
let chatwootDb = null, chatwootDbTried = false;
async function getChatwootDb() {
  if (chatwootDb || chatwootDbTried) return chatwootDb;
  chatwootDbTried = true;
  if (!CHATWOOT_DB_URL) return null;
  try { const pg = (await import("pg")).default; chatwootDb = new pg.Pool({ connectionString: CHATWOOT_DB_URL, max: 3 }); chatwootDb.on("error", (e) => console.error("chatwootDb pool", e.message)); console.log("chatwootDb: connected"); }
  catch (e) { console.error("chatwootDb init FAIL", e.message); chatwootDb = null; }
  return chatwootDb;
}

// ---- Google Sheets (optional): auto-save Form answers into a user's sheet (NO extra package) ----
const GOOGLE_SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
let _gTok = null, _gTokExp = 0;
async function getGoogleToken() {
  if (!GOOGLE_SA_JSON) return null;
  if (_gTok && Date.now() < _gTokExp - 60000) return _gTok;
  try {
    const creds = JSON.parse(GOOGLE_SA_JSON);
    const now = Math.floor(Date.now() / 1000);
    const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = b64u({ alg: "RS256", typ: "JWT" }) + "." + b64u({ iss: creds.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now });
    const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign((creds.private_key || "").replace(/\\n/g, "\n"), "base64url");
    const r = await axios.post("https://oauth2.googleapis.com/token", new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + signature }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 });
    _gTok = r.data.access_token; _gTokExp = Date.now() + (r.data.expires_in || 3600) * 1000;
    console.log("googleSheets: token ok (" + (creds.client_email || "?") + ")");
    return _gTok;
  } catch (e) { console.error("googleSheets token FAIL", e.response?.data?.error_description || e.message); return null; }
}
async function appendToSheet(sheetUrl, data) {
  try {
    if (!sheetUrl) return;
    const m = String(sheetUrl).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) { console.log("appendToSheet: bad sheet url"); return; }
    const token = await getGoogleToken();
    if (!token) { console.log("appendToSheet: GOOGLE_SERVICE_ACCOUNT_JSON not set/invalid"); return; }
    const id = m[1];
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values`;
    const H = { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 };
    let headers = [];
    try { const r = await axios.get(`${base}/A1:1`, H); headers = (r.data.values && r.data.values[0]) || []; } catch (e) {}
    let changed = false;
    for (const k of Object.keys(data)) { if (!headers.includes(k)) { headers.push(k); changed = true; } }
    if (changed) await axios.put(`${base}/A1?valueInputOption=RAW`, { values: [headers] }, H);
    const row = headers.map((h) => (data[h] != null ? String(data[h]) : ""));
    await axios.post(`${base}/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [row] }, H);
    console.log("appendToSheet OK", id);
  } catch (e) { console.error("appendToSheet FAIL", e.response?.data?.error?.message || e.message); }
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const seedFlow = JSON.parse(fs.readFileSync("./flow.json", "utf-8"));

// Reuse TCP/TLS connections to Chatwoot -> much faster replies on slow sslip.io https
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const cw = axios.create({ httpAgent, httpsAgent, timeout: 20000 });

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
const flowCache = new Map(); // account:inbox -> { row, exp }  (skips a DB hit per webhook)
function clearFlowCache() { flowCache.clear(); }
async function cachedPublishedFlow(accountId, inboxId) {
  const key = accountId + ":" + inboxId; const now = Date.now(); const c = flowCache.get(key);
  if (c && c.exp > now) return c.row;
  const row = await getPublishedFlowForInbox(accountId, inboxId);
  flowCache.set(key, { row, exp: now + 5000 });
  return row;
}

app.get("/api/flows", async (req, res) => { try { const a = parseInt(req.query.account_id, 10); if (!a) return res.status(400).json({ error: "account_id required" }); res.json({ flows: await listFlows(a) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows", async (req, res) => { try { const { account_id, name, inbox_id } = req.body || {}; const a = parseInt(account_id, 10); if (!a) return res.status(400).json({ error: "account_id required" }); const row = await createFlow(a, name, inbox_id != null ? parseInt(inbox_id, 10) : null); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, name: row.name, status: row.status, inbox_id: row.inbox_id } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/flows/:id", async (req, res) => { try { const row = await getFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); res.json({ flow: { id: row.id, name: row.name, status: row.status, inbox_id: row.inbox_id, definition: parseDef(row.definition) } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put("/api/flows/:id", async (req, res) => { try { const { name, definition } = req.body || {}; if (!definition || !definition.nodes) return res.status(400).json({ error: "definition required" }); const row = await saveFlowById(parseInt(req.params.id, 10), name, definition); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, name: row.name, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/publish", async (req, res) => { try { const row = await publishFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/unpublish", async (req, res) => { try { const row = await unpublishFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete("/api/flows/:id", async (req, res) => { try { await deleteFlowById(parseInt(req.params.id, 10)); clearFlowCache(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/assign-inbox", async (req, res) => { try { const inboxId = (req.body || {}).inbox_id; const row = await assignInbox(parseInt(req.params.id, 10), inboxId != null ? parseInt(inboxId, 10) : null); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, inbox_id: row.inbox_id } }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get("/api/inboxes", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!ADMIN_TOKEN) return res.status(400).json({ error: "CHATWOOT_API_TOKEN not set" });
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/inboxes`, { headers: { api_access_token: ADMIN_TOKEN } });
    res.json({ inboxes: (r.data?.payload || []).map((i) => ({ id: i.id, name: i.name, channel_type: i.channel_type })) });
  } catch (e) { console.error("GET /api/inboxes", e.response?.data || e.message); res.status(500).json({ error: e.message }); }
});

// labels list (for the Update Tag node dropdown in the builder)
app.get("/api/labels", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!ADMIN_TOKEN) return res.json({ labels: [] });
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/labels`, { headers: { api_access_token: ADMIN_TOKEN } });
    res.json({ labels: (r.data?.payload || []).map((l) => l.title) });
  } catch (e) { console.error("GET /api/labels", e.response?.data || e.message); res.json({ labels: [] }); }
});

// ===================== BOT ENGINE =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function apiPost(path2, body) {
  try { return await cw.post(`${CHATWOOT_BASE_URL}${path2}`, body, { headers: { api_access_token: BOT_TOKEN } }); }
  catch (e) {
    const st = e.response?.status;
    if ((st === 401 || st === 403) && ADMIN_TOKEN && ADMIN_TOKEN !== BOT_TOKEN) {
      console.log("apiPost: bot token rejected (" + st + ") on " + path2 + " — retrying with admin token");
      return cw.post(`${CHATWOOT_BASE_URL}${path2}`, body, { headers: { api_access_token: ADMIN_TOKEN } });
    }
    throw e;
  }
}
async function sendText(a, c, text) { if (!text) return; try { await apiPost(`/api/v1/accounts/${a}/conversations/${c}/messages`, { content: text, message_type: "outgoing" }); } catch (e) { console.error("sendText", e.response?.data || e.message); } }
// Chatwoot turns input_select into WhatsApp interactive buttons (<=3 items) or a list (>3 items)
async function sendOptions(a, c, text, titles) { try { await apiPost(`/api/v1/accounts/${a}/conversations/${c}/messages`, { content: text || " ", message_type: "outgoing", content_type: "input_select", content_attributes: { items: (titles || []).map((t) => ({ title: t, value: t })) } }); } catch (e) { console.error("sendOptions", e.response?.data || e.message); } }

// ===== Native WhatsApp Cloud interactive (real CTA button / list descriptions / footer) =====
const convCache = new Map();
async function getConvInfo(a, c) {
  const hit = convCache.get(c); if (hit && hit.exp > Date.now()) return hit.info;
  let info = { number: null, inboxId: null };
  try {
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}`, { headers: { api_access_token: ADMIN_TOKEN } });
    const d = r.data || {}; const meta = d.meta || {};
    let num = (meta.sender && (meta.sender.phone_number || meta.sender.identifier)) || "";
    info = { number: String(num).replace(/[^\d]/g, "") || null, inboxId: d.inbox_id ?? meta.inbox_id ?? null };
  } catch (e) { console.error("getConvInfo FAIL", e.response?.status, e.message); }
  convCache.set(c, { info, exp: Date.now() + 600000 });
  console.log("getConvInfo", c, "->", JSON.stringify(info));
  return info;
}
const credsCache = new Map();
async function getWaCreds(a, inboxId) {
  if (!inboxId) return null;
  const key = `${a}:${inboxId}`;
  const hit = credsCache.get(key); if (hit && hit.exp > Date.now()) return hit.creds;
  let creds = null;
  // 1) Chatwoot API (inbox provider_config) — works if Chatwoot returns the token
  try {
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/inboxes/${inboxId}`, { headers: { api_access_token: ADMIN_TOKEN } });
    const d = r.data || {}; const pc = d.provider_config || (d.channel && d.channel.provider_config) || {};
    const token = pc.api_key || pc.access_token; const phoneId = pc.phone_number_id;
    if (token && phoneId) creds = { token, phoneId, src: "api" };
  } catch (e) {}
  // 2) Chatwoot DB (reliable) — if CHATWOOT_DB_URL is set
  const db = await getChatwootDb();
  if (!creds && db) {
    try {
      const q = await db.query("SELECT cw.provider_config AS pc FROM channel_whatsapp cw JOIN inboxes i ON i.channel_id = cw.id WHERE i.id = $1 AND i.channel_type = 'Channel::Whatsapp' LIMIT 1", [inboxId]);
      const pc = (q.rows[0] && q.rows[0].pc) || {};
      const token = pc.api_key || pc.access_token; const phoneId = pc.phone_number_id;
      if (token && phoneId) creds = { token, phoneId, src: "db" };
    } catch (e) { console.error("waCreds DB FAIL", e.message); }
  }
  // 3) env fallback (single account, gated by WA_ACCOUNT_ID)
  if (!creds && WA_TOKEN && WA_PHONE_ID && (!WA_ACCOUNT_ID || String(a) === String(WA_ACCOUNT_ID))) creds = { token: WA_TOKEN, phoneId: WA_PHONE_ID, src: "env" };
  credsCache.set(key, { creds, exp: Date.now() + (creds ? 600000 : 120000) });
  console.log("getWaCreds", key, creds ? ("OK via " + creds.src) : "none");
  return creds;
}
function clip(x, n) { return x == null ? "" : String(x).slice(0, n); }
function waHeader(node, textOnly) {
  const h = node.header || {};
  if (h.type === "text" && h.value) return { type: "text", text: clip(h.value, 60) };
  if (!textOnly && ["image", "video", "document"].includes(h.type) && h.value) { const k = h.type; return { type: k, [k]: { link: h.value } }; }
  return null;
}
async function waSend(creds, to, interactive) {
  const r = await cw.post(`https://graph.facebook.com/${WA_VER}/${creds.phoneId}/messages`,
    { messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive },
    { headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" }, timeout: 15000 });
  console.log("waSend OK", interactive.type, "->", to, JSON.stringify(r.data?.messages || r.data));
  return r.data;
}
async function noteSent(a, c, body, options) {
  try { let txt = "🤖 " + (body || "(interactive sent)"); if (options && options.length) txt += "\n• " + options.filter(Boolean).join("\n• "); await apiPost(`/api/v1/accounts/${a}/conversations/${c}/messages`, { content: txt, message_type: "outgoing", private: true }); } catch (e) {}
}
async function trySendButtonsNative(a, c, node) {
  try {
    const info = await getConvInfo(a, c); if (!info.number || !info.inboxId) return false;
    const creds = await getWaCreds(a, info.inboxId); if (!creds) return false;
    const btns = (node.buttons || []).slice(0, 3).map((b, i) => ({ type: "reply", reply: { id: `b${i}`, title: clip(b.title || `Button ${i + 1}`, 20) } }));
    if (!btns.length) return false;
    const interactive = { type: "button", body: { text: clip(node.text || "Choose an option", 1024) }, action: { buttons: btns } };
    const hdr = waHeader(node, false); if (hdr) interactive.header = hdr;
    if (node.footer) interactive.footer = { text: clip(node.footer, 60) };
    await waSend(creds, info.number, interactive);
    await noteSent(a, c, node.text, btns.map((b) => b.reply.title));
    return true;
  } catch (e) { console.error("buttonsNative FAIL", e.response?.status, JSON.stringify(e.response?.data || e.message)); return false; }
}
async function trySendListNative(a, c, node) {
  try {
    const info = await getConvInfo(a, c); if (!info.number || !info.inboxId) return false;
    const creds = await getWaCreds(a, info.inboxId); if (!creds) return false;
    const h = node.header || {};
    if (["image", "video", "document"].includes(h.type) && h.value) { try { await sendMedia(a, c, h.value, ""); } catch (e) {} }
    const srcSecs = (Array.isArray(node.sections) && node.sections.length) ? node.sections : [{ title: "", rows: node.rows || [] }];
    const sections = []; let count = 0;
    for (const sec of srcSecs) {
      const rows = [];
      for (const r of (sec.rows || [])) { if (count >= 10) break; const row = { id: `r${count}`, title: clip(r.title || `Option ${count + 1}`, 24) }; if (r.description) row.description = clip(r.description, 72); rows.push(row); count++; }
      if (rows.length) sections.push({ title: clip(sec.title || "Options", 24), rows });
      if (count >= 10) break;
    }
    if (!count) return false;
    const interactive = { type: "list", body: { text: clip(node.body || "Choose an option", 1024) }, action: { button: clip(node.button || "Menu", 20), sections } };
    const hdr = waHeader(node, true); if (hdr) interactive.header = hdr;
    if (node.footer) interactive.footer = { text: clip(node.footer, 60) };
    await waSend(creds, info.number, interactive);
    await noteSent(a, c, node.body, listRows(node).map((r) => r.title));
    return true;
  } catch (e) { console.error("listNative FAIL", e.response?.status, JSON.stringify(e.response?.data || e.message)); return false; }
}
async function trySendCtaNative(a, c, node) {
  try {
    const info = await getConvInfo(a, c); if (!info.number || !info.inboxId) return false;
    const creds = await getWaCreds(a, info.inboxId); if (!creds) return false;
    const url = normUrl(node.url); if (!url) return false;
    const interactive = { type: "cta_url", body: { text: clip(node.body || "Tap the button below", 1024) }, action: { name: "cta_url", parameters: { display_text: clip(node.display || "Open link", 20), url } } };
    const hdr = waHeader(node, false); if (hdr) interactive.header = hdr;
    if (node.footer) interactive.footer = { text: clip(node.footer, 60) };
    await waSend(creds, info.number, interactive);
    await noteSent(a, c, (node.body || "") + "\n🔗 " + url, null);
    return true;
  } catch (e) { console.error("ctaNative FAIL", e.response?.status, JSON.stringify(e.response?.data || e.message)); return false; }
}
// fire-and-forget (do NOT await) -> first reply isn't delayed by the status toggle
function openConversation(a, c) { apiPost(`/api/v1/accounts/${a}/conversations/${c}/toggle_status`, { status: "open" }).catch((e) => console.error("openConversation", e.response?.data || e.message)); }

// Update Tag -> merge with existing labels (does not remove current ones)
async function addLabels(a, c, labels) {
  try {
    if (!labels || !labels.length) return;
    const H = { headers: { api_access_token: ADMIN_TOKEN } };
    // 1) make sure each label exists as an account label (create the missing ones)
    try {
      const al = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/labels`, H);
      const existing = (al.data?.payload || []).map((l) => (l.title || "").toLowerCase());
      for (const t of labels) {
        if (!existing.includes(String(t).toLowerCase())) {
          try { await cw.post(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/labels`, { title: String(t).toLowerCase().replace(/\s+/g, "_"), color: "#1f93ff", show_on_sidebar: true }, H); }
          catch (ce) { console.error("createLabel FAIL", t, ce.response?.status, ce.response?.data || ce.message); }
        }
      }
    } catch (le) { console.error("listLabels FAIL", le.response?.status, le.response?.data || le.message); }
    // 2) merge with the conversation's current labels and apply
    let cur = [];
    try { const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/labels`, H); cur = r.data?.payload || []; } catch {}
    const norm = labels.map((t) => String(t).toLowerCase().replace(/\s+/g, "_"));
    const merged = [...new Set([...cur, ...norm])];
    const resp = await cw.post(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/labels`, { labels: merged }, H);
    console.log("addLabels OK", c, JSON.stringify(merged), resp.status);
  } catch (e) { console.error("addLabels FAIL", e.response?.status, e.response?.data || e.message); }
}

function normUrl(u) { u = String(u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, ""); return u; }
function ctaText(node) {
  let out = (node.header && node.header.type === "text" && node.header.value ? node.header.value + "\n\n" : "") + (node.body || "");
  const u = normUrl(node.url);
  if (u) out += (out ? "\n\n" : "") + (node.display ? node.display + ": " : "") + u;
  if (node.footer) out += "\n\n_" + node.footer + "_";
  return out;
}

// ---- text helpers / matching ----
const norm = (s) => String(s == null ? "" : s).toLowerCase().trim();
const normLoose = (s) => norm(s).replace(/[^a-z0-9\u0600-\u06FF]+/g, "");
function levenshtein(a, b) {
  a = normLoose(a); b = normLoose(b);
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  const v0 = new Array(b.length + 1), v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) { const cost = a[i] === b[j] ? 0 : 1; v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost); }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}
function fuzzyEqual(a, b) {
  const x = normLoose(a), y = normLoose(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const d = levenshtein(x, y); const m = Math.max(x.length, y.length);
  return m > 0 && (1 - d / m) >= 0.8;
}
function simRatio(a, b) { const x = normLoose(a), y = normLoose(b); if (!x || !y) return 0; if (x === y) return 1; const d = levenshtein(x, y); const m = Math.max(x.length, y.length); return m ? 1 - d / m : 0; }
function fuzzyKeyword(text, k, threshold) { if (simRatio(text, k) >= threshold) return true; return norm(text).split(/\s+/).filter(Boolean).some((w) => simRatio(w, k) >= threshold); }
function matchKeywords(text, keywords, fuzzy, sensitivity) {
  const th = Math.min(Math.max((parseInt(sensitivity, 10) || 80) / 100, 0.3), 1);
  return (keywords || []).some((k) => fuzzy ? fuzzyKeyword(text, k, th) : normLoose(text) === normLoose(k));
}
function validateFormat(text, fmt) {
  const t = String(text || "").trim();
  switch (fmt) {
    case "text": return t.length > 0;
    case "number": return /^-?\d+(\.\d+)?$/.test(t);
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
    case "phone": return /^[+]?[\d\s\-()]{7,}$/.test(t);
    default: return true; // "any"
  }
}

// ---- condition evaluation (single + multi with All/Any + Fuzzy) ----
function evalSingle(cond, vars) {
  const subst = (str) => String(str == null ? "" : str).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  let a = cond.first ? subst(cond.first) : (vars.last_message || "");
  const b = subst(cond.second);
  const al = norm(a), bl = norm(b);
  switch (cond.operator || "equals") {
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
    case "fuzzy": return fuzzyEqual(a, b);
    default: return false;
  }
}
function evalConditionNode(node, vars) {
  const list = Array.isArray(node.conditions) && node.conditions.length ? node.conditions : [{ first: node.first, operator: node.operator, second: node.second }];
  return (node.match === "any") ? list.some((c) => evalSingle(c, vars)) : list.every((c) => evalSingle(c, vars));
}

// Map a file extension to a MIME type (Chatwoot needs the content type for attachments)
function extToMime(name) {
  const ext = (String(name).split("?")[0].split(".").pop() || "").toLowerCase();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", amr: "audio/amr", flac: "audio/flac", weba: "audio/webm", pdf: "application/pdf" };
  return map[ext] || "application/octet-stream";
}
const AUDIO_EXT = ["ogg", "oga", "opus", "wav", "m4a", "aac", "amr", "flac", "weba", "mka"];
function runFfmpeg(args) { return new Promise((res) => { try { const p = spawn("ffmpeg", args, { stdio: "ignore" }); p.on("close", (code) => res(code)); p.on("error", () => res(-1)); } catch { res(-1); } }); }
// WhatsApp Cloud rejects most .ogg/.wav audio (needs OGG-OPUS / mp3 / m4a / aac). Auto-convert any audio to MP3 before sending.
async function maybeTranscodeAudio(buffer, baseName) {
  const ext = (String(baseName).split(".").pop() || "").toLowerCase();
  if (!AUDIO_EXT.includes(ext)) return { buffer, filename: baseName, contentType: extToMime(baseName) };
  try {
    const tmpIn = path.join(os.tmpdir(), "csin_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6) + "." + ext);
    const tmpOut = path.join(os.tmpdir(), "csout_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6) + ".mp3");
    fs.writeFileSync(tmpIn, buffer);
    const code = await runFfmpeg(["-y", "-i", tmpIn, "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k", tmpOut]);
    if (code === 0 && fs.existsSync(tmpOut)) {
      const out = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpIn); } catch {} try { fs.unlinkSync(tmpOut); } catch {}
      return { buffer: out, filename: String(baseName).replace(/\.[^.]+$/, "") + ".mp3", contentType: "audio/mpeg" };
    }
    try { fs.unlinkSync(tmpIn); } catch {}
    console.error("transcode: ffmpeg failed (code " + code + ") for " + baseName + " — sending original");
  } catch (e) { console.error("transcode", e.message); }
  return { buffer, filename: baseName, contentType: extToMime(baseName) };
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
      const resp = await cw.get(url, { responseType: "arraybuffer", maxContentLength: Infinity, maxBodyLength: Infinity }); // external / pasted link
      buffer = Buffer.from(resp.data);
    }
    const tx = await maybeTranscodeAudio(buffer, path.basename(baseName)); // auto -> mp3 for audio
    const mediaUrl = `${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/messages`;
    const mkForm = () => { const f = new FormData(); if (caption) f.append("content", caption); f.append("message_type", "outgoing"); f.append("attachments[]", tx.buffer, { filename: tx.filename, contentType: tx.contentType }); return f; };
    const postForm = (tok) => { const f = mkForm(); return cw.post(mediaUrl, f, { headers: { api_access_token: tok, ...f.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity }); };
    try { await postForm(BOT_TOKEN); }
    catch (e) { const st = e.response?.status; if ((st === 401 || st === 403) && ADMIN_TOKEN && ADMIN_TOKEN !== BOT_TOKEN) { console.log("sendMedia: bot token rejected (" + st + "), retrying with admin token"); await postForm(ADMIN_TOKEN); } else throw e; }
  } catch (e) { console.error("sendMedia", e.response?.data || e.message); }
}

function toSession(row, fpa) { return { nodeId: row.node_id, awaiting: row.awaiting, variables: typeof row.variables === "string" ? JSON.parse(row.variables) : (row.variables || {}), flowPublishedAt: row.flow_published_at ? new Date(row.flow_published_at).toISOString() : fpa }; }

// rows of a list node (supports new sections[] or flat rows[])
function listRows(node) { return Array.isArray(node.sections) && node.sections.length ? node.sections.flatMap((s) => s.rows || []) : (node.rows || []); }
async function sendHeaderMedia(a, c, node) { const h = node.header || {}; if (["image", "video", "document"].includes(h.type) && h.value) await sendMedia(a, c, h.value, ""); }
function withHeaderFooter(node, body) { let out = (node.header && node.header.type === "text" && node.header.value ? node.header.value + "\n\n" : "") + (body || ""); if (node.footer) out += "\n\n_" + node.footer + "_"; return out; }

async function runFlow(a, c, s, def) {
  for (let i = 0; i < 100; i++) {
    const node = def.nodes[s.nodeId];
    if (!node) { s.awaiting = null; s.nodeId = null; return; }

    if (node.type === "text") { await sendText(a, c, node.text); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "media") { await sendMedia(a, c, node.url, node.caption); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "cta") { const okc = await trySendCtaNative(a, c, node); if (!okc) { await sendHeaderMedia(a, c, node); await sendText(a, c, ctaText(node)); } s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "tag") { await addLabels(a, c, node.labels || []); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "delay") { const secs = Math.max(0, Math.min(parseInt(node.seconds, 10) || 0, 300)); if (secs > 0) await sleep(secs * 1000); s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "condition") { const ok = evalConditionNode(node, s.variables || {}); s.nodeId = ok ? (node.next_true || null) : (node.next_false || null); if (s.nodeId) continue; s.awaiting = null; return; }

    if (node.type === "buttons") { await sendHeaderMedia(a, c, node); await sendOptions(a, c, withHeaderFooter(node, node.text), (node.buttons || []).map((b) => b.title)); s.awaiting = "buttons"; s.variables.__opts = s.nodeId; return; }

    if (node.type === "list") {
      const okl = await trySendListNative(a, c, node);
      if (!okl) {
        await sendHeaderMedia(a, c, node);
        const rows = listRows(node);
        let lbody = node.body || "";
        if (rows.some((r) => r.description)) lbody += "\n\n" + rows.map((r) => r.description ? `▸ ${r.title} — ${r.description}` : `▸ ${r.title}`).join("\n");
        await sendOptions(a, c, withHeaderFooter(node, lbody), rows.map((r) => r.title));
      }
      s.awaiting = "list"; s.variables.__opts = s.nodeId; return;
    }

    if (node.type === "form") {
      if (node.intro) await sendText(a, c, node.intro);
      const ff = (node.fields || []).filter((fd) => (fd.label || "").trim());
      if (!ff.length) { s.nodeId = node.next || null; if (s.nodeId) continue; s.awaiting = null; return; }
      s.awaiting = "form"; s.variables.__form_idx = 0; s.variables.__form_answers = {};
      await sendText(a, c, ff[0].label); return;
    }
    if (node.type === "question") { await sendText(a, c, node.text); s.awaiting = "question"; s.variables.__q_token = Math.random().toString(36).slice(2); return; }

    if (node.type === "handover") { if (node.text) await sendText(a, c, node.text); openConversation(a, c); s.awaiting = null; s.nodeId = null; return; }

    s.awaiting = null; s.nodeId = null; return;
  }
}

// runFlow + persist + (re)schedule question timeout
async function advance(a, c, s, def) { await runFlow(a, c, s, def); await saveSession(a, c, s); scheduleQuestionTimeout(a, c, s, def); }

function scheduleQuestionTimeout(a, c, s, def) {
  if (s.awaiting !== "question") return;
  const node = def.nodes[s.nodeId];
  if (!node || !node.timeout_seconds) return;
  const token = s.variables.__q_token;
  const ms = Math.max(1, Math.min(parseInt(node.timeout_seconds, 10) || 0, 3600)) * 1000;
  setTimeout(async () => {
    try {
      const cur = await getSession(a, c);
      if (!cur || cur.awaiting !== "question") return;
      const vars = typeof cur.variables === "string" ? JSON.parse(cur.variables) : (cur.variables || {});
      if (vars.__q_token !== token) return; // user replied, or a newer question replaced it
      const ns = toSession(cur, s.flowPublishedAt);
      if (node.timeout_message) await sendText(a, c, node.timeout_message);
      if (node.continue_on_timeout) { ns.awaiting = null; ns.nodeId = node.next || null; await runFlow(a, c, ns, def); }
      else { ns.awaiting = null; ns.nodeId = null; }
      await saveSession(a, c, ns);
    } catch (e) { console.error("qtimeout", e.message); }
  }, ms);
}

// find which "next" an incoming reply (button/list selection) maps to
function matchChoice(node, choice) {
  const t = norm(choice);
  if (!node) return null;
  if (node.type === "buttons") { const b = (node.buttons || []).find((x) => norm(x.title) === t); return b ? (b.next || null) : null; }
  if (node.type === "list") { const r = listRows(node).find((x) => norm(x.title) === t); return r ? (r.next || null) : null; }
  return null;
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    const accountId = event.account?.id; const conversationId = event.conversation?.id;
    const inboxId = event.conversation?.inbox_id ?? event.inbox?.id ?? event.conversation?.inbox?.id ?? null;
    if (!accountId || !conversationId) return;
    const flowRow = await cachedPublishedFlow(accountId, inboxId);
    if (!flowRow) return;
    const def = parseDef(flowRow.definition); if (!def.start) return;
    const flowPublishedAt = new Date(flowRow.published_at).toISOString();
    const session = await getSession(accountId, conversationId);

    // --- Website widget: button/list click arrives as message_updated + submitted_values ---
    const submitted = event.content_attributes?.submitted_values;
    if (event.event === "message_updated" && Array.isArray(submitted) && submitted.length > 0) {
      const choice = (submitted[0].value || submitted[0].title || "").trim();
      if (session) {
        const optsNode = session.node_id || (session.variables && (typeof session.variables === "string" ? JSON.parse(session.variables).__opts : session.variables.__opts));
        const next = matchChoice(def.nodes[session.node_id] || def.nodes[optsNode], choice);
        if (next) { const s = toSession(session, flowPublishedAt); s.variables.last_message = choice; s.nodeId = next; s.awaiting = null; await advance(accountId, conversationId, s, def); }
      }
      return;
    }

    if (event.event !== "message_created") return;
    if (event.message_type !== "incoming") return;
    const text = (event.content || "").trim();

    const isRepublished = session && session.flow_published_at && new Date(session.flow_published_at).getTime() < new Date(flowPublishedAt).getTime();

    // No session yet, or flow was re-published -> (re)start the flow (optionally gated by On Message keywords)
    if (!session || isRepublished) {
      const trig = def.trigger || {};
      if (trig.keywords && trig.keywords.length && !matchKeywords(text, trig.keywords, trig.fuzzy, trig.sensitivity)) return; // keyword set but not matched -> don't start
      openConversation(accountId, conversationId); // fire-and-forget (don't delay the reply)
      const s = { nodeId: def.start, awaiting: null, variables: { last_message: text }, flowPublishedAt };
      await advance(accountId, conversationId, s, def);
      return;
    }

    const s = toSession(session, flowPublishedAt);
    s.variables.last_message = text;

    // --- WhatsApp: a button/list reply comes back as a normal incoming text (the option's title) ---
    if (session.awaiting === "buttons" || session.awaiting === "list") {
      const menuId = session.node_id; const menuNode = def.nodes[menuId];
      const next = matchChoice(menuNode, text);
      if (next) {
        s.nodeId = next; s.awaiting = null; await advance(accountId, conversationId, s, def);
        if (menuNode && menuNode.loop_menu && !s.awaiting && !s.nodeId) { s.nodeId = menuId; await advance(accountId, conversationId, s, def); }
      }
      else { await saveSession(accountId, conversationId, s); } // no match -> stay, keep last_message
      return;
    }

    if (session.awaiting === "question") {
      const node = def.nodes[session.node_id];
      if (node && node.response_format && !validateFormat(text, node.response_format)) {
        await sendText(accountId, conversationId, node.text); // invalid format -> re-ask, stay awaiting
        await saveSession(accountId, conversationId, s);
        return;
      }
      if (node?.save_as) s.variables[node.save_as] = text;
      s.awaiting = null; s.nodeId = node?.next || null;
      await advance(accountId, conversationId, s, def);
      return;
    }

    if (session.awaiting === "form") {
      const fnode = def.nodes[session.node_id];
      const ff = ((fnode && fnode.fields) || []).filter((fd) => (fd.label || "").trim());
      let fidx = s.variables.__form_idx || 0;
      const fans = s.variables.__form_answers || {};
      const cur = ff[fidx];
      if (cur) { const k = cur.key || ("field_" + (fidx + 1)); fans[k] = text; s.variables[k] = text; }
      fidx++; s.variables.__form_answers = fans; s.variables.__form_idx = fidx;
      if (fidx < ff.length) { await sendText(accountId, conversationId, ff[fidx].label); await saveSession(accountId, conversationId, s); return; }
      const summary = "📋 *Form submitted:*\n" + ff.map((fd, i) => `• ${fd.key || ("field_" + (i + 1))}: ${fans[fd.key || ("field_" + (i + 1))] || "-"}`).join("\n");
      await sendText(accountId, conversationId, summary);
      if (fnode && fnode.submit_message) await sendText(accountId, conversationId, fnode.submit_message);
      if (fnode && fnode.sheet_url) { try { const _ci = await getConvInfo(accountId, conversationId); await appendToSheet(fnode.sheet_url, { Time: new Date().toLocaleString(), Phone: (_ci && _ci.number) || "", ...fans }); } catch (e) {} }
      delete s.variables.__form_idx; delete s.variables.__form_answers;
      s.awaiting = null; s.nodeId = (fnode && fnode.next) || null;
      await advance(accountId, conversationId, s, def);
      return;
    }

    // Flow ended, but the user tapped a button/row from the LAST options prompt -> honour it
    if (s.variables.__opts) {
      const menuId = s.variables.__opts; const menuNode = def.nodes[menuId];
      const next = matchChoice(menuNode, text);
      if (next) {
        s.nodeId = next; s.awaiting = null; await advance(accountId, conversationId, s, def);
        if (menuNode && menuNode.loop_menu && !s.awaiting && !s.nodeId) { s.nodeId = menuId; await advance(accountId, conversationId, s, def); }
        return;
      }
    }
    // otherwise stay quiet (agent may be handling it)
    return;
  } catch (e) { console.error("webhook error:", e.message); }
});

async function start() {
  await initDb();
  await seedFlowIfEmpty(3, seedFlow);
  app.listen(PORT, () => console.log(`ChatsSync bot engine listening on port ${PORT} | uploads: ${UPLOAD_DIR}`));
}
start().catch((e) => { console.error("Startup error:", e.message); process.exit(1); });
