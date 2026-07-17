// calendar.js — Google Calendar helper for ChatsSync appointment booking
import axios from 'axios';
import crypto from 'crypto';

let _tok = null, _tokExp = 0;

function getUTCOffset(tz, dateStr) {
  try {
    const utcDate = new Date(dateStr + 'T12:00:00Z');
    const local = new Date(utcDate.toLocaleString('en-US', { timeZone: tz }));
    const diff = (local - utcDate) / 60000;
    const sign = diff >= 0 ? '+' : '-';
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 60), m = abs % 60;
    return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  } catch { return '+05:00'; }
}

async function getToken(saJson) {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  try {
    const c = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    const now = Math.floor(Date.now() / 1000);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const hdr = b64({ alg: 'RS256', typ: 'JWT' });
    const pay = b64({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
    const sig = crypto.createSign('RSA-SHA256').update(`${hdr}.${pay}`).sign((c.private_key || '').replace(/\\n/g, '\n'), 'base64url');
    const r = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${hdr}.${pay}.${sig}` }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    _tok = r.data.access_token;
    _tokExp = Date.now() + (r.data.expires_in || 3600) * 1000;
    return _tok;
  } catch (e) { console.error('calToken FAIL', e.response?.data || e.message); return null; }
}

const tMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmtHHMM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function localMin(iso, tz) {
  try {
    const p = Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false }).formatToParts(new Date(iso));
    return parseInt(p.find(x => x.type === 'hour').value) * 60 + parseInt(p.find(x => x.type === 'minute').value);
  } catch { return 0; }
}

export async function getSlots(saJson, calId, dateStr, cfg) {
  if (!saJson || !calId || !dateStr) return [];
  const tz = cfg.timezone || 'Asia/Karachi';
  const dur = Math.max(15, parseInt(cfg.slot_duration) || 30);
  const buf = Math.max(0, parseInt(cfg.buffer_time) || 0);
  const dayS = tMin(cfg.start_time || '09:00');
  const dayE = tMin(cfg.end_time || '17:00');

  const [y, mo, d] = dateStr.split('-').map(Number);
  const dow = new Date(y, mo - 1, d).getDay();
  const wdays = (cfg.working_days || '1,2,3,4,5').split(',').map(Number);
  if (!wdays.includes(dow)) return [];

  const today = new Date();
  const sel = new Date(y, mo - 1, d);
  if (sel < new Date(today.getFullYear(), today.getMonth(), today.getDate())) return [];

  const advDays = parseInt(cfg.advance_days) || 14;
  const maxDate = new Date(today.getTime() + advDays * 86400000);
  if (sel > maxDate) return [];

  const token = await getToken(saJson);
  if (!token) return [];

  const offset = getUTCOffset(tz, dateStr);
  let busy = [];
  try {
    const r = await axios.post('https://www.googleapis.com/calendar/v3/freeBusy',
      { timeMin: `${dateStr}T00:00:00${offset}`, timeMax: `${dateStr}T23:59:59${offset}`, timeZone: tz, items: [{ id: calId }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    busy = (r.data.calendars?.[calId]?.busy || []).map(b => ({ s: localMin(b.start, tz), e: localMin(b.end, tz) }));
  } catch (e) { console.error('freeBusy FAIL', e.response?.data?.error || e.message); return []; }

  let slotS = dayS;
  if (sel.toDateString() === today.toDateString()) {
    const nowM = today.getHours() * 60 + today.getMinutes() + 60;
    slotS = dayS + Math.ceil(Math.max(0, nowM - dayS) / dur) * dur;
  }

  const slots = [];
  for (let cur = slotS; cur + dur <= dayE; cur += dur + buf) {
    if (!busy.some(b => cur < b.e && cur + dur > b.s)) {
      const h = Math.floor(cur / 60), m = cur % 60;
      const ap = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      slots.push({ value: fmtHHMM(cur), label: `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}` });
    }
  }
  return slots;
}

export async function createEvent(saJson, calId, dateStr, timeStr, name, notes, title, dur, tz) {
  const token = await getToken(saJson);
  if (!token) throw new Error('Calendar auth failed');
  const d = Math.max(15, parseInt(dur) || 30);
  const [h, m] = timeStr.split(':').map(Number);
  const eMin = h * 60 + m + d;
  const s = `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const e = `${dateStr}T${String(Math.floor(eMin / 60)).padStart(2, '0')}:${String(eMin % 60).padStart(2, '0')}:00`;
  const r = await axios.post(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
    {
      summary: `${title || 'Appointment'} — ${name}`,
      description: `Customer: ${name}${notes ? '\nNotes: ' + notes : ''}\n\nBooked via ChatsSync`,
      start: { dateTime: s, timeZone: tz || 'Asia/Karachi' },
      end: { dateTime: e, timeZone: tz || 'Asia/Karachi' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] }
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return r.data;
}
