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
  getApptSettings, saveApptSettings,
  listApptBookings, createApptBooking, getApptBookingBySlot,
} from "./db.js";

const PORT = process.env.PORT || 3000;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const BOT_TOKEN = process.env.CHATWOOT_BOT_TOKEN;
const ADMIN_TOKEN = process.env.CHATWOOT_API_TOKEN;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const WA_TOKEN = process.env.WA_TOKEN || "";
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID || "";
const WA_VER = process.env.WA_GRAPH_VERSION || "v21.0";
const WA_ACCOUNT_ID = process.env.WA_ACCOUNT_ID || "";
const waEnabled =!!(WA_TOKEN && WA_PHONE_ID);
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
function sheetIdFromUrl(sheetUrl) {
  const m = String(sheetUrl || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m? m[1] : null;
}
async function appendToSheet(sheetUrl, data) {
  try {
    if (!sheetUrl) return;
    const id = sheetIdFromUrl(sheetUrl);
    if (!id) { console.log("appendToSheet: bad sheet url"); return; }
    const token = await getGoogleToken();
    if (!token) { console.log("appendToSheet: GOOGLE_SERVICE_ACCOUNT_JSON not set/invalid"); return; }
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values`;
    const H = { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 };
    let headers = [];
    try { const r = await axios.get(`${base}/A1:1`, H); headers = (r.data.values && r.data.values[0]) || []; } catch (e) {}
    let changed = false;
    for (const k of Object.keys(data)) { if (!headers.includes(k)) { headers.push(k); changed = true; } }
    if (changed) await axios.put(`${base}/A1?valueInputOption=RAW`, { values: [headers] }, H);
    const row = headers.map((h) => (data[h]!= null? String(data[h]) : ""));
    await axios.post(`${base}/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [row] }, H);
    console.log("appendToSheet OK", id);
  } catch (e) { console.error("appendToSheet FAIL", e.response?.data?.error?.message || e.message); }
}
async function checkSheetAccess(sheetUrl) {
  const id = sheetIdFromUrl(sheetUrl);
  if (!id) return { ok: false, error: "That doesn't look like a Google Sheets link." };
  const token = await getGoogleToken();
  if (!token) return { ok: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON not set on the server." };
  try {
    await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    return { ok: true };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return { ok: false, error: "Couldn't access this sheet. Share it with the service account email (Editor access). " + msg };
  }
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const seedFlow = JSON.parse(fs.readFileSync("./flow.json", "utf-8"));
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
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static("public"));
app.get("/", (req, res) => res.send("ChatsSync bot engine is running"));
const parseDef = (d) => (typeof d === "string"? JSON.parse(d) : d);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => { const ext = path.extname(file.originalname || ""); cb(null, "m" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext); },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });
function mediaType(mime) { if (!mime) return "document"; if (mime.startsWith("image/")) return "image"; if (mime.startsWith("video/")) return "video"; if (mime.startsWith("audio/")) return "audio"; return "document"; }
function fileUrl(req, filename) { return PUBLIC_BASE_URL? `${PUBLIC_BASE_URL}/uploads/${filename}` : `${req.protocol}://${req.get("host")}/uploads/${filename}`; }

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

const flowCache = new Map();
function clearFlowCache() { flowCache.clear(); }
async function cachedPublishedFlow(accountId, inboxId) {
  const key = accountId + ":" + inboxId; const now = Date.now(); const c = flowCache.get(key);
  if (c && c.exp > now) return c.row;
  const row = await getPublishedFlowForInbox(accountId, inboxId);
  flowCache.set(key, { row, exp: now + 5000 });
  return row;
}

app.get("/api/flows", async (req, res) => { try { const a = parseInt(req.query.account_id, 10); if (!a) return res.status(400).json({ error: "account_id required" }); res.json({ flows: await listFlows(a) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows", async (req, res) => { try { const { account_id, name, inbox_id } = req.body || {}; const a = parseInt(account_id, 10); if (!a) return res.status(400).json({ error: "account_id required" }); const row = await createFlow(a, name, inbox_id!= null? parseInt(inbox_id, 10) : null); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, name: row.name, status: row.status, inbox_id: row.inbox_id } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/flows/:id", async (req, res) => { try { const row = await getFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); res.json({ flow: { id: row.id, name: row.name, status: row.status, inbox_id: row.inbox_id, definition: parseDef(row.definition) } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put("/api/flows/:id", async (req, res) => { try { const { name, definition } = req.body || {}; if (!definition ||!definition.nodes) return res.status(400).json({ error: "definition required" }); const row = await saveFlowById(parseInt(req.params.id, 10), name, definition); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, name: row.name, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/publish", async (req, res) => { try { const row = await publishFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/unpublish", async (req, res) => { try { const row = await unpublishFlowById(parseInt(req.params.id, 10)); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, status: row.status } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete("/api/flows/:id", async (req, res) => { try { await deleteFlowById(parseInt(req.params.id, 10)); clearFlowCache(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/flows/:id/assign-inbox", async (req, res) => { try { const inboxId = (req.body || {}).inbox_id; const row = await assignInbox(parseInt(req.params.id, 10), inboxId!= null? parseInt(inboxId, 10) : null); if (!row) return res.status(404).json({ error: "not found" }); clearFlowCache(); res.json({ ok: true, flow: { id: row.id, inbox_id: row.inbox_id } }); } catch (e) { res.status(500).json({ error: e.message }); } });

function pad2(n) { return String(n).padStart(2, "0"); }
function dateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function minutesToHHMM(mins) { const h = Math.floor(mins / 60), m = mins % 60; return `${pad2(h)}:${pad2(m)}`; }
function hhmmToMinutes(hhmm) { const [h, m] = String(hhmm || "00:00").split(":").map((x) => parseInt(x, 10) || 0); return h * 60 + m; }
function buildDaySlots(cfg, dateISO) {
  const wdays = String(cfg.working_days || "1,2,3,4,5").split(",").map((x) => parseInt(x, 10));
  const d = new Date(dateISO + "T00:00:00");
  if (!wdays.includes(d.getDay())) return [];
  const startMin = hhmmToMinutes(cfg.start_time || "09:00");
  const endMin = hhmmToMinutes(cfg.end_time || "17:00");
  const dur = Math.max(5, parseInt(cfg.slot_duration, 10) || 30);
  const buf = Math.max(0, parseInt(cfg.buffer_time, 10) || 0);
  const step = dur + buf;
  const out = [];
  for (let t = startMin; t + dur <= endMin; t += step) out.push(minutesToHHMM(t));
  return out;
}
function fmtDateLabel(dateISO) {
  const [y, mo, d] = dateISO.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${parseInt(d, 10)} ${months[parseInt(mo, 10) - 1]} ${y}`;
}
function fmtTimeLabel(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12? "PM" : "AM";
  const h12 = h === 0? 12 : h > 12? h - 12 : h;
  return `${pad2(h12)}:${pad2(m)} ${ap}`;
}

app.get("/api/appointments/settings", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    const s = await getApptSettings(accountId);
    res.json({ ok: true, settings: s || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/appointments/settings", async (req, res) => {
  try {
    const { account_id, sheet_url,...settings } = req.body || {};
    const accountId = parseInt(account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (sheet_url && sheet_url.trim()) {
      const chk = await checkSheetAccess(sheet_url.trim());
      if (!chk.ok) return res.status(400).json({ error: chk.error });
    }
    const row = await saveApptSettings(accountId, {...settings, sheet_url: (sheet_url || "").trim() });
    res.json({ ok: true, settings: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/appointments/check-sheet", async (req, res) => {
  try {
    const { sheet_url } = req.body || {};
    if (!sheet_url) return res.status(400).json({ error: "sheet_url required" });
    const chk = await checkSheetAccess(sheet_url);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    let serviceEmail = "";
    if (GOOGLE_SA_JSON) { try { serviceEmail = JSON.parse(GOOGLE_SA_JSON).client_email || ""; } catch {} }
    res.json({ ok: true, service_email: serviceEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/appointments/service-email", async (req, res) => {
  let serviceEmail = "";
  if (GOOGLE_SA_JSON) { try { serviceEmail = JSON.parse(GOOGLE_SA_JSON).client_email || ""; } catch {} }
  res.json({ ok: true, service_email: serviceEmail });
});

app.get("/api/appointments/slots", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    const date = req.query.date;
    if (!accountId ||!date) return res.status(400).json({ error: "account_id and date required" });
    const cfg = (await getApptSettings(accountId)) || {};
    const all = buildDaySlots(cfg, date);
    const booked = new Set((await listApptBookings(accountId, date)).map((b) => b.time));
    const slots = all.map((t) => ({ time: t, label: fmtTimeLabel(t), available:!booked.has(t) }));
    res.json({ ok: true, date, date_label: fmtDateLabel(date), slots });
  } catch (e) { console.error("GET /api/appointments/slots", e.message); res.status(500).json({ error: e.message }); }
});

async function buildUpcomingSlotOptions(accountId, maxOptions) {
  const cfg = (await getApptSettings(accountId)) || {};
  const advance = Math.max(1, Math.min(parseInt(cfg.advance_days, 10) || 14, 30));
  const today = new Date();
  const out = [];
  for (let i = 0; i < advance && out.length < (maxOptions || 25); i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const iso = dateStr(d);
    const daySlots = buildDaySlots(cfg, iso);
    if (!daySlots.length) continue;
    const booked = new Set((await listApptBookings(accountId, iso)).map((b) => b.time));
    for (const t of daySlots) {
      if (booked.has(t)) continue;
      out.push({ id: `${iso}|${t}`, title: `${fmtDateLabel(iso)} - ${fmtTimeLabel(t)}` });
      if (out.length >= (maxOptions || 25)) break;
    }
  }
  return out;
}

app.get("/api/appointments/dates", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    const cfg = (await getApptSettings(accountId)) || {};
    const advance = Math.max(1, Math.min(parseInt(cfg.advance_days, 10) || 14, 90));
    const out = [];
    const today = new Date();
    for (let i = 0; i < advance && out.length < 30; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = dateStr(d);
      if (buildDaySlots(cfg, iso).length) out.push({ date: iso, label: fmtDateLabel(iso) });
    }
    res.json({ ok: true, dates: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function bookAppointmentInternal(accountId, { date, time, answers, convId }) {
  const cfg = (await getApptSettings(accountId)) || {};
  const daySlots = buildDaySlots(cfg, date);
  if (!daySlots.includes(time)) return { ok: false, error: "That time isn't a valid slot." };
  const existing = await getApptBookingBySlot(accountId, date, time);
  if (existing) return { ok: false, error: "slot_taken" };
  const row = await createApptBooking(accountId, date, time, answers || {}, convId || null);
  if (cfg.sheet_url) {
    const sheetRow = { Time: new Date().toLocaleString(), Date: fmtDateLabel(date), Slot: fmtTimeLabel(time),...(answers || {}) };
    appendToSheet(cfg.sheet_url, sheetRow).catch(() => {});
  }
  return { ok: true, booking: row };
}

// ===== FIXED: Flow Builder - Integrity Error Fix =====
function sanitizeFieldName(str, idx) {
  let s = String(str || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = "field_" + idx;
  if (/^[0-9]/.test(s)) s = "f_" + s;
  return s.slice(0, 32);
}
function getMappedQuestions(questions) {
  const seen = new Set();
  const out = [];
  (questions || []).forEach((q, idx) => {
    if (!(q.label || "").trim()) return;
    let base = sanitizeFieldName(q.key || q.label, idx);
    if (base === "slot") base = "slot_field";
    let name = base;
    let c = 1;
    while (seen.has(name)) { name = `${base}_${c++}`; }
    seen.add(name);
    out.push({
      label: String(q.label).slice(0, 30),
      originalKey: q.key || q.label,
      sanitized: name,
      input_type: q.input_type
    });
  });
  return out;
}

function buildApptFlowJson(questions) {
  const mapped = getMappedQuestions(questions);
  const qFields = mapped.map(q => ({
    type: "TextInput",
    required: true,
    label: q.label,
    name: q.sanitized,
    "input-type": ["number","email","phone"].includes(q.input_type)? q.input_type : "text",
  }));

  return {
    version: "7.1",
    screens: [
      {
        id: "BOOKING",
        title: "Book Appointment",
        terminal: true,
        data: {
          slots: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } }
          }
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            { type: "TextHeading", text: "Select date & time" },
            { type: "Dropdown", name: "slot", label: "Date and time", required: true, "data-source": "${data.slots}" },
           ...qFields,
            {
              type: "Footer",
              label: "Confirm booking",
              "on-click-action": {
                name: "complete",
                payload: Object.fromEntries([
                  ["slot", "${form.slot}"],
                 ...mapped.map(f => [f.sanitized, `\${form.${f.sanitized}}`])
                ])
              }
            },
          ],
        },
      },
    ],
  };
}

app.get("/api/appointments/flow-json", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    const cfg = (await getApptSettings(accountId)) || {};
    const questions = (cfg.questions? (typeof cfg.questions === "string"? JSON.parse(cfg.questions) : cfg.questions) : []);
    res.json({ ok: true, flow_json: buildApptFlowJson(questions) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function graphCreateFlow(token, wabaId, name) {
  const uniqueName = `Appt ${Date.now()}`.slice(0, 40);
  const r = await axios.post(`https://graph.facebook.com/${WA_VER}/${wabaId}/flows`,
    { name: uniqueName, categories: ["APPOINTMENT_BOOKING"] },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 20000 });
  return r.data;
}
async function graphUploadFlowAsset(token, flowId, flowJsonObj) {
  const fd = new FormData();
  fd.append("name", "flow.json");
  fd.append("asset_type", "FLOW_JSON");
  fd.append("file", Buffer.from(JSON.stringify(flowJsonObj)), { filename: "flow.json", contentType: "application/json" });
  const r = await axios.post(`https://graph.facebook.com/${WA_VER}/${flowId}/assets`, fd,
    { headers: { Authorization: `Bearer ${token}`,...fd.getHeaders() }, timeout: 20000 });
  return r.data;
}
async function graphPublishFlow(token, flowId) {
  const r = await axios.post(`https://graph.facebook.com/${WA_VER}/${flowId}/publish`, {},
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
  return r.data;
}
async function graphGetFlowStatus(token, flowId) {
  const r = await axios.get(`https://graph.facebook.com/${WA_VER}/${flowId}?fields=status,validation_errors`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
  return r.data;
}

app.post("/api/appointments/create-flow", async (req, res) => {
  try {
    const { account_id, inbox_id, waba_id } = req.body || {};
    const accountId = parseInt(account_id, 10);
    const inboxId = parseInt(inbox_id, 10);
    if (!accountId ||!inboxId ||!waba_id) return res.status(400).json({ error: "account_id, inbox_id and waba_id are all required" });
    const creds = await getWaCreds(accountId, inboxId);
    if (!creds) return res.status(400).json({ error: "Couldn't find WhatsApp API credentials for that number. Make sure it's a connected Cloud API inbox." });

    const cfg = (await getApptSettings(accountId)) || {};
    const questions = (cfg.questions? (typeof cfg.questions === "string"? JSON.parse(cfg.questions) : cfg.questions) : []);
    const flowJson = buildApptFlowJson(questions);

    let flowId = cfg.flow_id || "";
    // If old flow_id is stuck in ERROR, verify it, if invalid create new
    if (flowId) {
      try {
        await graphGetFlowStatus(creds.token, flowId);
      } catch (e) {
        console.log(`Old flow_id ${flowId} invalid, will create new one`);
        flowId = "";
      }
    }

    try {
      if (!flowId) {
        const created = await graphCreateFlow(creds.token, waba_id, "Appointment Booking");
        flowId = created.id;
        console.log("Created new flow:", flowId);
      }
      console.log("Uploading flow JSON:", JSON.stringify(flowJson).slice(0, 500));
      await graphUploadFlowAsset(creds.token, flowId, flowJson);
      await graphPublishFlow(creds.token, flowId);
      await saveApptSettings(accountId, {...cfg, waba_id, flow_id: flowId, flow_inbox_id: inboxId, flow_status: "PUBLISHED" });
      res.json({ ok: true, flow_id: flowId, status: "PUBLISHED" });
    } catch (ge) {
      console.error("Flow create/publish FAIL FULL:", JSON.stringify(ge.response?.data || {}, null, 2));
      const detail = ge.response?.data?.error?.error_user_msg || ge.response?.data?.error?.message || ge.response?.data?.error?.error_user_title || ge.message;
      let validation = "";
      try {
        if (flowId) {
          const status = await graphGetFlowStatus(creds.token, flowId);
          if (status.validation_errors && status.validation_errors.length) {
            validation = " | Validation: " + JSON.stringify(status.validation_errors).slice(0, 500);
          }
        }
      } catch {}
      if (flowId) await saveApptSettings(accountId, {...cfg, waba_id, flow_id: flowId, flow_inbox_id: inboxId, flow_status: "ERROR" });
      res.status(400).json({ error: "Meta rejected the Flow: " + detail + validation, flow_id: flowId || null });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get("/api/appointments/flow-status", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    const cfg = (await getApptSettings(accountId)) || {};
    if (!cfg.flow_id) return res.json({ ok: true, flow_id: null });
    const creds = await getWaCreds(accountId, cfg.flow_inbox_id);
    if (!creds) return res.json({ ok: true, flow_id: cfg.flow_id, status: cfg.flow_status || "unknown" });
    try {
      const live = await graphGetFlowStatus(creds.token, cfg.flow_id);
      res.json({ ok: true, flow_id: cfg.flow_id, status: live.status, validation_errors: live.validation_errors || [] });
    } catch (ge) { res.json({ ok: true, flow_id: cfg.flow_id, status: cfg.flow_status || "unknown" }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/appointments/bookings", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    const date = req.query.date || null;
    res.json({ ok: true, bookings: await listApptBookings(accountId, date) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/inboxes", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!ADMIN_TOKEN) return res.status(400).json({ error: "CHATWOOT_API_TOKEN not set" });
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/inboxes`, { headers: { api_access_token: ADMIN_TOKEN } });
    res.json({ inboxes: (r.data?.payload || []).map((i) => ({ id: i.id, name: i.name, channel_type: i.channel_type })) });
  } catch (e) { console.error("GET /api/inboxes", e.response?.data || e.message); res.status(500).json({ error: e.message }); }
});

app.get("/api/labels", async (req, res) => {
  try {
    const accountId = parseInt(req.query.account_id, 10);
    if (!accountId) return res.status(400).json({ error: "account_id required" });
    if (!ADMIN_TOKEN) return res.json({ labels: [] });
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/labels`, { headers: { api_access_token: ADMIN_TOKEN } });
    res.json({ labels: (r.data?.payload || []).map((l) => l.title) });
  } catch (e) { console.error("GET /api/labels", e.response?.data || e.message); res.json({ labels: [] }); }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function apiPost(path2, body) {
  try { return await cw.post(`${CHATWOOT_BASE_URL}${path2}`, body, { headers: { api_access_token: BOT_TOKEN } }); }
  catch (e) {
    const st = e.response?.status;
    if ((st === 401 || st === 403) && ADMIN_TOKEN && ADMIN_TOKEN!== BOT_TOKEN) {
      console.log("apiPost: bot token rejected (" + st + ") on " + path2 + " — retrying with admin token");
      return cw.post(`${CHATWOOT_BASE_URL}${path2}`, body, { headers: { api_access_token: ADMIN_TOKEN } });
    }
    throw e;
  }
}
async function sendText(a, c, text) { if (!text) return; try { await apiPost(`/api/v1/accounts/${a}/conversations/${c}/messages`, { content: text, message_type: "outgoing" }); } catch (e) { console.error("sendText", e.response?.data || e.message); } }
async function sendOptions(a, c, text, titles) { try { const tl = titles || []; const maxLen = tl.length <= 3? 20 : 24; await apiPost(`/api/v1/accounts/${a}/conversations/${c}/messages`, { content: text || " ", message_type: "outgoing", content_type: "input_select", content_attributes: { items: tl.map((t) => { const tt = String(t).slice(0, maxLen); return { title: tt, value: tt }; }) } }); } catch (e) { console.error("sendOptions", e.response?.data || e.message); } }

async function sendFormField(a, c, field) {
  const type = (field && field.type) || "text";
  if ((type === "list" || type === "buttons") && Array.isArray(field.options) && field.options.length) {
    const titles = field.options.map((o) => (o && o.title? String(o.title) : "")).filter(Boolean);
    if (titles.length) { await sendOptions(a, c, field.label || "Please choose:", titles); return; }
  }
  await sendText(a, c, field.label || "");
}

function catProductTitle(p) { return `${p.name}${p.price? " — Rs " + p.price : ""}`; }
async function sendCatalogProducts(a, c, prods) {
  const lines = prods.map((p, i) => `*${i + 1}.* ${p.name}${p.price? " — Rs " + p.price : ""}${p.desc? "\n _" + p.desc + "_" : ""}`);
  const msg = "🛍 *Hamare Products:*\n\n" + lines.join("\n") + "\n\n👉 Order karne ke liye product ka *number* likhein (e.g. 1)";
  await sendText(a, c, msg);
}
async function sendCatalogQty(a, c, node, prod) {
  const qtys = (node.qty_options && node.qty_options.length? node.qty_options : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]).map((x) => String(x)).slice(0, 10);
  await sendOptions(a, c, `*${prod.name}* — kitne chahiye?`, qtys);
}
async function sendCatalogMore(a, c, node) {
  const addL = (node.add_more_label || "➕ Add more").slice(0, 20);
  const coL = (node.checkout_label || "✅ Confirm").slice(0, 20);
  await sendOptions(a, c, "Aur kuch?", [addL, coL]);
}
function cartTotal(cart) { return (cart || []).reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0); }
function cartLines(cart) { return (cart || []).map((it) => `• ${it.name} x${it.qty} — Rs ${(Number(it.price) || 0) * (Number(it.qty) || 0)}`).join("\n"); }
function cartSummaryText(cart) { return cartLines(cart) + `\n\n*Total: Rs ${cartTotal(cart)}*`; }
function buildCartMsg(cnode, cart, prod, qty, lineTotal) {
  const tmpl = (cnode && cnode.cart_line && cnode.cart_line.trim())? cnode.cart_line : "🛒 *Aapka cart:*\n{{cart}}\n\n*Total: Rs {{cartTotal}}*";
  return tmpl
   .replace(/\{\{\s*cart\s*\}\}/g, cartLines(cart))
   .replace(/\{\{\s*item\s*\}\}/g, prod.name)
   .replace(/\{\{\s*qty\s*\}\}/g, String(qty))
   .replace(/\{\{\s*lineTotal\s*\}\}/g, String(lineTotal))
   .replace(/\{\{\s*cartTotal\s*\}\}/g, String(cartTotal(cart)));
}
async function finishCatalogOrder(a, c, s, def, cnode, cart, fans) {
  const summary = "🧾 *Order Summary*\n" + cartSummaryText(cart) +
    (Object.keys(fans || {}).length? "\n\n" + Object.entries(fans).map(([k, v]) => `• ${k}: ${v}`).join("\n") : "");
  await sendText(a, c, summary);
  if (cnode && cnode.submit_message) await sendText(a, c, cnode.submit_message);
  if (cnode && cnode.sheet_url) {
    try {
      const _ci = await getConvInfo(a, c);
      const itemsStr = (cart || []).map((it) => `${it.name} x${it.qty}`).join(", ");
      await appendToSheet(cnode.sheet_url, { Time: new Date().toLocaleString(), Phone: (_ci && _ci.number) || "", Order: itemsStr, Total: cartTotal(cart),...fans });
    } catch (e) {}
  }
  delete s.variables.__cart; delete s.variables.__cat_stage; delete s.variables.__cat_pick;
  delete s.variables.__form_idx; delete s.variables.__form_answers;
  s.awaiting = null; s.nodeId = (cnode && cnode.next) || null;
  await advance(a, c, s, def);
}

const convCache = new Map();
async function getConvInfo(a, c) {
  const hit = convCache.get(c); if (hit && hit.exp > Date.now()) return hit.info;
  let info = { number: null, inboxId: null };
  try {
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}`, { headers: { api_access_token: ADMIN_TOKEN } });
    const d = r.data || {}; const meta = d.meta || {};
    let num = (meta.sender && (meta.sender.phone_number || meta.sender.identifier)) || "";
    info = { number: String(num).replace(/[^\d]/g, "") || null, inboxId: d.inbox_id?? meta.inbox_id?? null };
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
  try {
    const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/inboxes/${inboxId}`, { headers: { api_access_token: ADMIN_TOKEN } });
    const d = r.data || {}; const pc = d.provider_config || (d.channel && d.channel.provider_config) || {};
    const token = pc.api_key || pc.access_token; const phoneId = pc.phone_number_id;
    if (token && phoneId) creds = { token, phoneId, src: "api" };
  } catch (e) {}
  const db = await getChatwootDb();
  if (!creds && db) {
    try {
      const q = await db.query("SELECT cw.provider_config AS pc FROM channel_whatsapp cw JOIN inboxes i ON i.channel_id = cw.id WHERE i.id = $1 AND i.channel_type = 'Channel::Whatsapp' LIMIT 1", [inboxId]);
      const pc = (q.rows[0] && q.rows[0].pc) || {};
      const token = pc.api_key || pc.access_token; const phoneId = pc.phone_number_id;
      if (token && phoneId) creds = { token, phoneId, src: "db" };
    } catch (e) { console.error("waCreds DB FAIL", e.message); }
  }
  if (!creds && WA_TOKEN && WA_PHONE_ID && (!WA_ACCOUNT_ID || String(a) === String(WA_ACCOUNT_ID))) creds = { token: WA_TOKEN, phoneId: WA_PHONE_ID, src: "env" };
  credsCache.set(key, { creds, exp: Date.now() + (creds? 600000 : 120000) });
  console.log("getWaCreds", key, creds? ("OK via " + creds.src) : "none");
  return creds;
}
function clip(x, n) { return x == null? "" : String(x).slice(0, n); }
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
    const info = await getConvInfo(a, c); if (!info.number ||!info.inboxId) return false;
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
    const info = await getConvInfo(a, c); if (!info.number ||!info.inboxId) return false;
    const creds = await getWaCreds(a, info.inboxId); if (!creds) return false;
    const h = node.header || {};
    if (["image", "video", "document"].includes(h.type) && h.value) { try { await sendMedia(a, c, h.value, ""); } catch (e) {} }
    const srcSecs = (Array.isArray(node.sections) && node.sections.length)? node.sections : [{ title: "", rows: node.rows || [] }];
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
    const info = await getConvInfo(a, c); if (!info.number ||!info.inboxId) return false;
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

async function trySendFlowNative(a, c, node) {
  try {
    const info = await getConvInfo(a, c); if (!info.number ||!info.inboxId) return false;
    const creds = await getWaCreds(a, info.inboxId); if (!creds) return false;
    const cfg = (await getApptSettings(a)) || {};
    const flowId = cfg.flow_id || node.flow_id || process.env.WA_APPOINTMENT_FLOW_ID || "";
    if (!flowId) return false;
    const slots = await buildUpcomingSlotOptions(a, 25);
    if (!slots.length) { await sendText(a, c, "Abhi koi slot available nahi hai."); return true; }
    const interactive = {
      type: "flow",
      body: { text: clip(node.text || "Book an appointment", 1024) },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: crypto.randomBytes(12).toString("hex"),
          flow_id: flowId,
          flow_cta: clip(node.button_text || "Book Appointment", 20),
          flow_action: "navigate",
          flow_action_payload: { screen: "BOOKING", data: { slots } },
        },
      },
    };
    if (node.footer) interactive.footer = { text: clip(node.footer, 60) };
    await waSend(creds, info.number, interactive);
    await noteSent(a, c, node.text, ["📅 Flow: " + (node.button_text || "Book Appointment")]);
    return true;
  } catch (e) { console.error("flowNative FAIL", e.response?.status, JSON.stringify(e.response?.data || e.message)); return false; }
}

function openConversation(a, c) { apiPost(`/api/v1/accounts/${a}/conversations/${c}/toggle_status`, { status: "open" }).catch((e) => console.error("openConversation", e.response?.data || e.message)); }

async function addLabels(a, c, labels) {
  try {
    if (!labels ||!labels.length) return;
    const H = { headers: { api_access_token: ADMIN_TOKEN } };
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
    let cur = [];
    try { const r = await cw.get(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/labels`, H); cur = r.data?.payload || []; } catch {}
    const norm = labels.map((t) => String(t).toLowerCase().replace(/\s+/g, "_"));
    const merged = [...new Set([...cur,...norm])];
    const resp = await cw.post(`${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/labels`, { labels: merged }, H);
    console.log("addLabels OK", c, JSON.stringify(merged), resp.status);
  } catch (e) { console.error("addLabels FAIL", e.response?.status, e.response?.data || e.message); }
}

function normUrl(u) { u = String(u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, ""); return u; }
function ctaText(node) {
  let out = (node.header && node.header.type === "text" && node.header.value? node.header.value + "\n\n" : "") + (node.body || "");
  const u = normUrl(node.url);
  if (u) out += (out? "\n\n" : "") + (node.display? node.display + ": " : "") + u;
  if (node.footer) out += "\n\n_" + node.footer + "_";
  return out;
}

const norm = (s) => String(s == null? "" : s).toLowerCase().trim();
const normLoose = (s) => norm(s).replace(/[^a-z0-9\u0600-\u06FF]+/g, "");
function levenshtein(a, b) {
  a = normLoose(a); b = normLoose(b);
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  const v0 = new Array(b.length + 1), v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) { const cost = a[i] === b[j]? 0 : 1; v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost); }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}
function fuzzyEqual(a, b) {
  const x = normLoose(a), y = normLoose(b);
  if (!x ||!y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const d = levenshtein(x, y); const m = Math.max(x.length, y.length);
  return m > 0 && (1 - d / m) >= 0.8;
}
function simRatio(a, b) { const x = normLoose(a), y = normLoose(b); if (!x ||!y) return 0; if (x === y) return 1; const d = levenshtein(x, y); const m = Math.max(x.length, y.length); return m? 1 - d / m : 0; }
function fuzzyKeyword(text, k, threshold) { if (simRatio(text, k) >= threshold) return true; return norm(text).split(/\s+/).filter(Boolean).some((w) => simRatio(w, k) >= threshold); }
function matchKeywords(text, keywords, fuzzy, sensitivity) {
  const th = Math.min(Math.max((parseInt(sensitivity, 10) || 80) / 100, 0.3), 1);
  return (keywords || []).some((k) => fuzzy? fuzzyKeyword(text, k, th) : normLoose(text) === normLoose(k));
}
function validateFormat(text, fmt) {
  const t = String(text || "").trim();
  switch (fmt) {
    case "text": return t.length > 0;
    case "number": return /^-?\d+(\.\d+)?$/.test(t);
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
    case "phone": return /^[+]?[\d\s\-()]{7,}$/.test(t);
    default: return true;
  }
}

function evalSingle(cond, vars) {
  const subst = (str) => String(str == null? "" : str).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k]!= null? String(vars[k]) : ""));
  let a = cond.first? subst(cond.first) : (vars.last_message || "");
  const b = subst(cond.second);
  const al = norm(a), bl = norm(b);
  switch (cond.operator || "equals") {
    case "equals": return al === bl;
    case "not_equals": return al!== bl;
    case "contains": return al.includes(bl);
    case "not_contains": return!al.includes(bl);
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
  const list = Array.isArray(node.conditions) && node.conditions.length? node.conditions : [{ first: node.first, operator: node.operator, second: node.second }];
  return (node.match === "any")? list.some((c) => evalSingle(c, vars)) : list.every((c) => evalSingle(c, vars));
}

function extToMime(name) {
  const ext = (String(name).split("?")[0].split(".").pop() || "").toLowerCase();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", amr: "audio/amr", flac: "audio/flac", weba: "audio/webm", pdf: "application/pdf" };
  return map[ext] || "application/octet-stream";
}
const AUDIO_EXT = ["ogg", "oga", "opus", "wav", "m4a", "aac", "amr", "flac", "weba", "mka"];
function runFfmpeg(args) { return new Promise((res) => { try { const p = spawn("ffmpeg", args, { stdio: "ignore" }); p.on("close", (code) => res(code)); p.on("error", () => res(-1)); } catch { res(-1); } }); }
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

async function sendMedia(a, c, url, caption) {
  try {
    if (!url) return;
    const clean = String(url).split("?")[0];
    const baseName = decodeURIComponent(clean.split("/uploads/")[1] || clean.split("/").pop() || "file");
    const localPath = path.join(UPLOAD_DIR, path.basename(baseName));
    let buffer;
    if (clean.includes("/uploads/") && fs.existsSync(localPath)) {
      buffer = fs.readFileSync(localPath);
    } else {
      const resp = await cw.get(url, { responseType: "arraybuffer", maxContentLength: Infinity, maxBodyLength: Infinity });
      buffer = Buffer.from(resp.data);
    }
    const tx = await maybeTranscodeAudio(buffer, path.basename(baseName));
    const mediaUrl = `${CHATWOOT_BASE_URL}/api/v1/accounts/${a}/conversations/${c}/messages`;
    const mkForm = () => { const f = new FormData(); if (caption) f.append("content", caption); f.append("message_type", "outgoing"); f.append("attachments[]", tx.buffer, { filename: tx.filename, contentType: tx.contentType }); return f; };
    const postForm = (tok) => { const f = mkForm(); return cw.post(mediaUrl, f, { headers: { api_access_token: tok,...f.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity }); };
    try { await postForm(BOT_TOKEN); }
    catch (e) { const st = e.response?.status; if ((st === 401 || st === 403) && ADMIN_TOKEN && ADMIN_TOKEN!== BOT_TOKEN) { console.log("sendMedia: bot token rejected (" + st + "), retrying with admin token"); await postForm(ADMIN_TOKEN); } else throw e; }
  } catch (e) { console.error("sendMedia", e.response?.data || e.message); }
}

function toSession(row, fpa) { return { nodeId: row.node_id, awaiting: row.awaiting, variables: typeof row.variables === "string"? JSON.parse(row.variables) : (row.variables || {}), flowPublishedAt: row.flow_published_at? new Date(row.flow_published_at).toISOString() : fpa }; }
function listRows(node) { return Array.isArray(node.sections) && node.sections.length? node.sections.flatMap((s) => s.rows || []) : (node.rows || []); }
async function sendHeaderMedia(a, c, node) { const h = node.header || {}; if (["image", "video", "document"].includes(h.type) && h.value) await sendMedia(a, c, h.value, ""); }
function withHeaderFooter(node, body) { let out = (node.header && node.header.type === "text" && node.header.value? node.header.value + "\n\n" : "") + (body || ""); if (node.footer) out += "\n\n_" + node.footer + "_"; return out; }
function substVars(str, vars) { return (str == null? str : String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => ((vars && vars[k]!= null)? String(vars[k]) : ""))); }

async function runFlow(a, c, s, def) {
  const startId = s.nodeId;
  const queue = Array.isArray(startId)? startId.filter(Boolean) : (startId? [startId] : []);
  if (!queue.length) { s.awaiting = null; s.nodeId = null; return; }
  if (s.variables) { delete s.variables.__delay_token; delete s.variables.__delay_next; delete s.variables.__delay_secs; }
  const seen = new Set();
  const vars = s.variables || {};
  const subst = (str) => substVars(str, vars);
  const applyVars = (node) => {
    if (!node || typeof node!== "object") return node;
    const n = {...node };
    ["text", "caption", "body", "intro", "footer", "submit_message", "timeout_message"].forEach((k) => { if (typeof n[k] === "string") n[k] = subst(n[k]); });
    if (n.header && n.header.type === "text" && typeof n.header.value === "string") n.header = {...n.header, value: subst(n.header.value) };
    if (Array.isArray(n.buttons)) n.buttons = n.buttons.map((b) => (b && typeof b === "object"? {...b, title: subst(b.title) } : b));
    if (Array.isArray(n.rows)) n.rows = n.rows.map((r) => (r && typeof r === "object"? {...r, title: subst(r.title), description: subst(r.description) } : r));
    if (Array.isArray(n.sections)) n.sections = n.sections.map((sec) => (sec && typeof sec === "object"? {...sec, rows: Array.isArray(sec.rows)? sec.rows.map((r) => (r && typeof r === "object"? {...r, title: subst(r.title), description: subst(r.description) } : r)) : sec.rows } : sec));
    if (Array.isArray(n.fields)) n.fields = n.fields.map((f) => (f && typeof f === "object"? {...f, label: subst(f.label) } : f));
    return n;
  };
  const nextsOf = (node) => { const v = node.next; const arr = Array.isArray(v)? v : (v? [v] : []); return arr.filter(Boolean); };
  let awaitNode = null;
  let delayNode = null;
  let steps = 0;
  while (queue.length && steps < 300) {
    steps++;
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawNode = def.nodes[id];
    if (!rawNode) continue;
    const node = applyVars(rawNode);
    if (node.type === "text") { await sendText(a, c, node.text); nextsOf(node).forEach((x) => queue.push(x)); continue; }
    if (node.type === "media") { await sendMedia(a, c, node.url, node.caption); nextsOf(node).forEach((x) => queue.push(x)); continue; }
    if (node.type === "cta") { const okc = await trySendCtaNative(a, c, node); if (!okc) { await sendHeaderMedia(a, c, node); await sendText(a, c, ctaText(node)); } nextsOf(node).forEach((x) => queue.push(x)); continue; }
    if (node.type === "tag") { await addLabels(a, c, node.labels || []); nextsOf(node).forEach((x) => queue.push(x)); continue; }
    if (node.type === "handover") { if (node.text) await sendText(a, c, node.text); openConversation(a, c); continue; }
    if (node.type === "condition") { const ok = evalConditionNode(node, s.variables || {}); const t = ok? node.next_true : node.next_false; (Array.isArray(t)? t : (t? [t] : [])).forEach((x) => x && queue.push(x)); continue; }
    if (node.type === "delay") {
      const secs = Math.max(0, Math.min(parseInt(node.seconds, 10) || 0, 86400));
      if (secs <= 0) { nextsOf(node).forEach((x) => queue.push(x)); continue; }
      delayNode = { nodeId: id, next: (Array.isArray(node.next)? node.next : (node.next || null)), secs };
      continue;
    }
    if (node.type === "appointment") {
      const ok = await trySendFlowNative(a, c, node);
      if (!ok) {
        await sendText(a, c, (node.text || "📅 Appointment booking") + "\n\n⚠ Flow not configured yet — set WA_APPOINTMENT_FLOW_ID or the node's flow_id.");
      }
      s.variables.__appt_node = id;
      awaitNode = { type: "appointment", nodeId: id };
      const dn = nextsOf(node);
      if (dn.length) { s.variables.__appt_next = dn; }
      continue;
    }
    if (node.type === "buttons" || node.type === "list") {
      if (node.type === "buttons") {
        if (node.text_menu) { await sendHeaderMedia(a, c, node); const opts = (node.buttons || []).map((b, i) => `${i + 1}. ${b.title}`).join("\n"); await sendText(a, c, withHeaderFooter(node, (node.text || "Choose an option:") + "\n\n" + opts)); }
        else { await sendHeaderMedia(a, c, node); await sendOptions(a, c, withHeaderFooter(node, node.text), (node.buttons || []).map((b) => b.title)); }
      } else {
        if (node.text_menu) { await sendHeaderMedia(a, c, node); const rows = listRows(node); const opts = rows.map((r, i) => r.description? `${i + 1}. ${r.title} — ${r.description}` : `${i + 1}. ${r.title}`).join("\n"); await sendText(a, c, withHeaderFooter(node, (node.body || "Choose an option:") + "\n\n" + opts)); }
        else { const okl = await trySendListNative(a, c, node); if (!okl) { await sendHeaderMedia(a, c, node); const rows = listRows(node); let lbody = node.body || ""; if (rows.some((r) => r.description)) lbody += "\n\n" + rows.map((r) => r.description? `▸ ${r.title} — ${r.description}` : `▸ ${r.title}`).join("\n"); await sendOptions(a, c, withHeaderFooter(node, lbody), rows.map((r) => r.title)); } }
      }
      s.variables.__opts = id; s.variables.__menus = [...(s.variables.__menus || []).filter((x) => x!== id), id].slice(-8);
      const dn = nextsOf(node);
      if (dn.length) { dn.forEach((x) => queue.push(x)); }
      else { awaitNode = { type: node.type, nodeId: id }; }
      continue;
    }
    if (node.type === "form") {
      if (node.intro) await sendText(a, c, node.intro);
      const ff = (node.fields || []).filter((fd) => (fd.label || "").trim());
      if (!ff.length) { nextsOf(node).forEach((x) => queue.push(x)); continue; }
      s.variables.__form_idx = 0; s.variables.__form_answers = {};
      await sendFormField(a, c, ff[0]);
      awaitNode = { type: "form", nodeId: id };
      continue;
    }
    if (node.type === "catalog") {
      const prods = (node.products || []).filter((p) => (p.name || "").trim());
      if (!prods.length) { nextsOf(node).forEach((x) => queue.push(x)); continue; }
      if (node.intro) await sendText(a, c, node.intro);
      s.variables.__cart = [];
      s.variables.__cat_stage = "pick";
      s.variables.__form_idx = 0; s.variables.__form_answers = {};
      await sendCatalogProducts(a, c, prods);
      awaitNode = { type: "catalog", nodeId: id };
      continue;
    }
    if (node.type === "question") {
      await sendText(a, c, node.text);
      s.variables.__q_token = Math.random().toString(36).slice(2);
      awaitNode = { type: "question", nodeId: id };
      continue;
    }
  }
  if (delayNode) {
    s.variables.__delay_token = Math.random().toString(36).slice(2);
    s.variables.__delay_next = delayNode.next;
    s.variables.__delay_secs = delayNode.secs;
  }
  if (awaitNode) { s.awaiting = awaitNode.type; s.nodeId = awaitNode.nodeId; }
  else if (delayNode) { s.awaiting = "delay"; s.nodeId = delayNode.nodeId; }
  else { s.awaiting = null; s.nodeId = null; }
}

async function advance(a, c, s, def) { await runFlow(a, c, s, def); await saveSession(a, c, s); scheduleQuestionTimeout(a, c, s, def); scheduleDelayResume(a, c, s, def); }

function scheduleDelayResume(a, c, s, def) {
  const token = s.variables && s.variables.__delay_token;
  if (!token) return;
  const secs = Math.max(0, Math.min(parseInt(s.variables.__delay_secs, 10) || 0, 86400));
  if (secs <= 0) return;
  const nextId = s.variables.__delay_next || null;
  const inboxId = (s.variables.__inbox!= null? s.variables.__inbox : null);
  const publishedAt = s.flowPublishedAt;
  setTimeout(async () => {
    try {
      const cur = await getSession(a, c);
      if (!cur) return;
      const vars = typeof cur.variables === "string"? JSON.parse(cur.variables) : (cur.variables || {});
      if (vars.__delay_token!== token) return;
      const fr = await cachedPublishedFlow(a, inboxId);
      if (!fr) return;
      if (new Date(fr.published_at).toISOString()!== publishedAt) return;
      const curDef = parseDef(fr.definition);
      const ns = toSession(cur, publishedAt);
      ns.nodeId = nextId; ns.awaiting = null;
      await runFlow(a, c, ns, curDef);
      await saveSession(a, c, ns);
      scheduleQuestionTimeout(a, c, ns, curDef);
      scheduleDelayResume(a, c, ns, curDef);
    } catch (e) { console.error("delayresume", e.message); }
  }, secs * 1000);
}

function scheduleQuestionTimeout(a, c, s, def) {
  if (s.awaiting!== "question") return;
  const node = def.nodes[s.nodeId];
  if (!node ||!node.timeout_seconds) return;
  const token = s.variables.__q_token;
  const ms = Math.max(1, Math.min(parseInt(node.timeout_seconds, 10) || 0, 3600)) * 1000;
  setTimeout(async () => {
    try {
      const cur = await getSession(a, c);
      if (!cur || cur.awaiting!== "question") return;
      const vars = typeof cur.variables === "string"? JSON.parse(cur.variables) : (cur.variables || {});
      if (vars.__q_token!== token) return;
      const ns = toSession(cur, s.flowPublishedAt);
      if (node.timeout_message) await sendText(a, c, node.timeout_message);
      if (node.continue_on_timeout) { ns.awaiting = null; ns.nodeId = node.next || null; await runFlow(a, c, ns, def); }
      else { ns.awaiting = null; ns.nodeId = null; }
      await saveSession(a, c, ns);
    } catch (e) { console.error("qtimeout", e.message); }
  }, ms);
}

function matchChoice(node, choice) {
  const t = norm(choice);
  if (!node) return null;
  const raw = String(choice).trim();
  const byNum = (arr) => { if (/^\d+$/.test(raw)) { const n = parseInt(raw, 10); if (n >= 1 && n <= arr.length) return arr[n - 1]; } return null; };
  if (node.type === "buttons") { const arr = node.buttons || []; const hit = byNum(arr) || arr.find((x) => norm(x.title) === t); return hit? (hit.next || null) : null; }
  if (node.type === "list") { const arr = listRows(node); const hit = byNum(arr) || arr.find((x) => norm(x.title) === t); return hit? (hit.next || null) : null; }
  return null;
}

function resolveMenuChoice(def, s, text) {
  const vars = s.variables || {};
  const order = [];
  if (s.awaiting === "buttons" || s.awaiting === "list") order.push(s.nodeId);
  if (vars.__opts) order.push(vars.__opts);
  const menus = vars.__menus || [];
  for (let i = menus.length - 1; i >= 0; i--) order.push(menus[i]);
  const tried = new Set();
  for (const id of order) {
    if (id == null || tried.has(id)) continue;
    tried.add(id);
    const next = matchChoice(def.nodes[id], text);
    if (next) return { menuId: id, next };
  }
  return null;
}

async function handleFlowSubmission(accountId, conversationId, s, def, nfmResponse) {
  let payload = {};
  try { payload = typeof nfmResponse.response_json === "string"? JSON.parse(nfmResponse.response_json) : (nfmResponse.response_json || {}); } catch (e) {}
  const slotVal = String(payload.slot || "");
  const [date, time] = slotVal.split("|");

  const cfg = (await getApptSettings(accountId)) || {};
  const questions = (cfg.questions? (typeof cfg.questions === "string"? JSON.parse(cfg.questions) : cfg.questions) : []);
  const mapped = getMappedQuestions(questions);

  const answers = {};
  for (const m of mapped) {
    if (payload[m.sanitized]!= null) {
      answers[m.originalKey] = payload[m.sanitized];
    }
  }

  if (!date ||!time) {
    await sendText(accountId, conversationId, "Booking mein date/time nahi mila. Dobara try karein.");
    return;
  }
  const result = await bookAppointmentInternal(accountId, { date, time, answers, convId: conversationId });
  if (!result.ok) {
    if (result.error === "slot_taken") await sendText(accountId, conversationId, "😔 Yeh slot abhi kisi aur ne le liya. Dobara try karein, koi aur time select karein.");
    else await sendText(accountId, conversationId, "Booking nahi ho saki: " + (result.error || "unknown error"));
    return;
  }
  const answerLines = Object.entries(answers).map(([k, v]) => `👤 ${k}: ${v}`).join("\n");
  const msg = `✅ *Appointment Confirmed!*\n\n📅 Date: ${fmtDateLabel(date)}\n⏰ Time: ${fmtTimeLabel(time)}${answerLines? "\n" + answerLines : ""}\n\nHum aapka intezaar karenge! 🙌`;
  await sendText(accountId, conversationId, msg);
  delete s.variables.__appt_node;
  const nextIds = s.variables.__appt_next || [];
  delete s.variables.__appt_next;
  s.awaiting = null;
  s.nodeId = nextIds && nextIds.length? nextIds : null;
  await advance(accountId, conversationId, s, def);
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    const accountId = event.account?.id; const conversationId = event.conversation?.id;
    const inboxId = event.conversation?.inbox_id?? event.inbox?.id?? event.conversation?.inbox?.id?? null;
    if (!accountId ||!conversationId) return;
    const _sender = event.sender || event.conversation?.meta?.sender || {};
    const senderVars = {
      senderName: _sender.name || _sender.available_name || "",
      senderId: _sender.phone_number || _sender.identifier || "",
      receiverId: event.conversation?.meta?.channel_source_id || event.inbox?.phone_number || "",
    };
    const flowRow = await cachedPublishedFlow(accountId, inboxId);
    if (!flowRow) return;
    const def = parseDef(flowRow.definition); if (!def.start) return;
    const flowPublishedAt = new Date(flowRow.published_at).toISOString();
    const session = await getSession(accountId, conversationId);

    const nfm = event.content_attributes?.nfm_reply || event.additional_attributes?.nfm_reply || null;
    if (nfm && session) {
      const s = toSession(session, flowPublishedAt);
      s.variables.__inbox = inboxId; Object.assign(s.variables, senderVars);
      if (session.awaiting === "appointment") {
        await handleFlowSubmission(accountId, conversationId, s, def, nfm);
        return;
      }
    }

    const submitted = event.content_attributes?.submitted_values;
    if (event.event === "message_updated" && Array.isArray(submitted) && submitted.length > 0) {
      const choice = (submitted[0].value || submitted[0].title || "").trim();
      if (session) {
        const s = toSession(session, flowPublishedAt); s.variables.last_message = choice; s.variables.message = choice; s.variables.__inbox = inboxId; Object.assign(s.variables, senderVars);
        if (session.awaiting === "catalog" || session.awaiting === "form") {
          if (!event.content ||!event.content.trim()) { event.content = choice; event.event = "message_created"; event.message_type = "incoming"; }
          else return;
        } else {
        const mc = resolveMenuChoice(def, s, choice);
        if (mc) {
          const mNode = def.nodes[mc.menuId];
          s.nodeId = mc.next; s.awaiting = null; await advance(accountId, conversationId, s, def);
          if (mNode && mNode.loop_menu &&!s.awaiting &&!s.nodeId) { s.nodeId = mc.menuId; await advance(accountId, conversationId, s, def); }
        } else if (s.awaiting === "buttons" || s.awaiting === "list") {
          const cur = def.nodes[s.nodeId];
          if (cur && cur.loop_menu) { s.awaiting = null; await advance(accountId, conversationId, s, def); }
        }
        return;
        }
      } else return;
    }

    if (event.event!== "message_created") return;
    if (event.message_type!== "incoming") return;
    const text = (event.content || "").trim();
    const isRepublished = session && session.flow_published_at && new Date(session.flow_published_at).getTime() < new Date(flowPublishedAt).getTime();
    if (!session || isRepublished) {
      const trig = def.trigger || {};
      if (trig.keywords && trig.keywords.length &&!matchKeywords(text, trig.keywords, trig.fuzzy, trig.sensitivity)) return;
      openConversation(accountId, conversationId);
      const s = { nodeId: def.start, awaiting: null, variables: { last_message: text, message: text, __inbox: inboxId,...senderVars }, flowPublishedAt };
      await advance(accountId, conversationId, s, def);
      return;
    }
    const s = toSession(session, flowPublishedAt);
    s.variables.last_message = text;
    s.variables.message = text;
    s.variables.__inbox = inboxId;
    Object.assign(s.variables, senderVars);
    if (session.awaiting === "appointment") {
      await saveSession(accountId, conversationId, s);
      return;
    }
    if (session.awaiting === "question") {
      const node = def.nodes[session.node_id];
      if (node && node.response_format &&!validateFormat(text, node.response_format)) {
        await sendText(accountId, conversationId, substVars(node.text, s.variables));
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
      if (fidx < ff.length) { await sendFormField(accountId, conversationId, {...ff[fidx], label: substVars(ff[fidx].label, s.variables) }); await saveSession(accountId, conversationId, s); return; }
      const summary = "📋 *Form submitted:*\n" + ff.map((fd, i) => `• ${fd.key || ("field_" + (i + 1))}: ${fans[fd.key || ("field_" + (i + 1))] || "-"}`).join("\n");
      await sendText(accountId, conversationId, summary);
      if (fnode && fnode.submit_message) await sendText(accountId, conversationId, fnode.submit_message);
      if (fnode && fnode.sheet_url) { try { const _ci = await getConvInfo(accountId, conversationId); await appendToSheet(fnode.sheet_url, { Time: new Date().toLocaleString(), Phone: (_ci && _ci.number) || "",...fans }); } catch (e) {} }
      delete s.variables.__form_idx; delete s.variables.__form_answers;
      s.awaiting = null; s.nodeId = (fnode && fnode.next) || null;
      await advance(accountId, conversationId, s, def);
      return;
    }
    if (session.awaiting === "catalog") {
      const cnode = def.nodes[session.node_id];
      const prods = ((cnode && cnode.products) || []).filter((p) => (p.name || "").trim());
      const cart = s.variables.__cart || [];
      const stage = s.variables.__cat_stage || "pick";
      const addL = ((cnode && cnode.add_more_label) || "➕ Add more").slice(0, 20);
      const coL = ((cnode && cnode.checkout_label) || "✅ Confirm").slice(0, 20);
      const t = (text || "").trim();
      if (stage === "pick") {
        let idx = -1;
        const num = parseInt(t.replace(/[^\d]/g, ""), 10);
        if (num >= 1 && num <= prods.length && String(num) === t.replace(/[^\d]/g, "")) idx = num - 1;
        if (idx < 0) idx = prods.findIndex((p) => catProductTitle(p) === t || (p.name || "").trim().toLowerCase() === t.toLowerCase());
        if (idx < 0) { await sendCatalogProducts(accountId, conversationId, prods); await saveSession(accountId, conversationId, s); return; }
        s.variables.__cat_pick = idx; s.variables.__cat_stage = "qty";
        await sendCatalogQty(accountId, conversationId, cnode, prods[idx]);
        await saveSession(accountId, conversationId, s); return;
      }
      if (stage === "qty") {
        const qty = parseInt(t.replace(/[^\d]/g, ""), 10);
        const pIdx = s.variables.__cat_pick;
        const prod = prods[pIdx];
        if (!prod ||!qty || qty < 1) { if (prod) await sendCatalogQty(accountId, conversationId, cnode, prod); await saveSession(accountId, conversationId, s); return; }
        const lineTotal = (Number(prod.price) || 0) * qty;
        const existing = cart.find((it) => it.name === prod.name);
        if (existing) existing.qty = (Number(existing.qty) || 0) + qty;
        else cart.push({ name: prod.name, price: Number(prod.price) || 0, qty });
        s.variables.__cart = cart;
        await sendText(accountId, conversationId, buildCartMsg(cnode, cart, prod, qty, lineTotal));
        s.variables.__cat_stage = "more";
        await sendCatalogMore(accountId, conversationId, cnode);
        await saveSession(accountId, conversationId, s); return;
      }
      if (stage === "more") {
        if (t === addL || /add|aur|more|zyada/i.test(t)) {
          s.variables.__cat_stage = "pick";
          await sendCatalogProducts(accountId, conversationId, prods);
          await saveSession(accountId, conversationId, s); return;
        }
        if (t === coL || /check?out|complete|done|order|confirm|ho?gaya|bas/i.test(t)) {
          const ff = ((cnode && cnode.fields) || []).filter((fd) => (fd.label || "").trim());
          s.variables.__cat_stage = "form"; s.variables.__form_idx = 0; s.variables.__form_answers = {};
          if (ff.length) { await sendFormField(accountId, conversationId, ff[0]); await saveSession(accountId, conversationId, s); return; }
          await finishCatalogOrder(accountId, conversationId, s, def, cnode, cart, {});
          return;
        }
        await sendCatalogMore(accountId, conversationId, cnode);
        await saveSession(accountId, conversationId, s); return;
      }
      if (stage === "form") {
        const ff = ((cnode && cnode.fields) || []).filter((fd) => (fd.label || "").trim());
        let fidx = s.variables.__form_idx || 0;
        const fans = s.variables.__form_answers || {};
        const cur = ff[fidx];
        if (cur) { const k = cur.key || ("field_" + (fidx + 1)); fans[k] = t; s.variables[k] = t; }
        fidx++; s.variables.__form_answers = fans; s.variables.__form_idx = fidx;
        if (fidx < ff.length) { await sendFormField(accountId, conversationId, {...ff[fidx], label: substVars(ff[fidx].label, s.variables) }); await saveSession(accountId, conversationId, s); return; }
        await finishCatalogOrder(accountId, conversationId, s, def, cnode, cart, fans);
        return;
      }
      await saveSession(accountId, conversationId, s); return;
    }
    const mc = resolveMenuChoice(def, s, text);
    if (mc) {
      const mNode = def.nodes[mc.menuId];
      s.nodeId = mc.next; s.awaiting = null; await advance(accountId, conversationId, s, def);
      if (mNode && mNode.loop_menu &&!s.awaiting &&!s.nodeId) { s.nodeId = mc.menuId; await advance(accountId, conversationId, s, def); }
      return;
    }
    if (session.awaiting === "buttons" || session.awaiting === "list") {
      const cur = def.nodes[session.node_id];
      if (cur && cur.loop_menu) { s.nodeId = session.node_id; s.awaiting = null; await advance(accountId, conversationId, s, def); }
      else { await saveSession(accountId, conversationId, s); }
      return;
    }
    return;
  } catch (e) { console.error("webhook error:", e.message); }
});

async function start() {
  await initDb();
  await seedFlowIfEmpty(3, seedFlow);
  app.listen(PORT, () => console.log(`ChatsSync bot engine listening on port ${PORT} | uploads: ${UPLOAD_DIR}`));
}
start().catch((e) => { console.error("Startup error:", e.message); process.exit(1); });
