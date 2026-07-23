import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flows (
      id SERIAL PRIMARY KEY, account_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT 'Default flow', definition JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'published', published_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await pool.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS inbox_id INTEGER;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      id SERIAL PRIMARY KEY, account_id INTEGER NOT NULL, conversation_id INTEGER NOT NULL,
      node_id TEXT, awaiting TEXT, variables JSONB NOT NULL DEFAULT '{}'::jsonb,
      flow_published_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (account_id, conversation_id)
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY, account_id INTEGER NOT NULL,
      filename TEXT NOT NULL, original_name TEXT, url TEXT NOT NULL,
      type TEXT, size BIGINT, created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  // ===== Appointments — replaces the old calendar_settings table. =====
  // No Google Calendar: slots are tracked entirely in appt_bookings, and
  // appt_settings holds the working-hours config + Google Sheet link +
  // the merchant's custom questions (JSONB array of {label, key, input_type}).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appt_settings (
      account_id INTEGER PRIMARY KEY,
      working_days TEXT DEFAULT '1,2,3,4,5',
      start_time TEXT DEFAULT '09:00',
      end_time TEXT DEFAULT '17:00',
      slot_duration INTEGER DEFAULT 30,
      buffer_time INTEGER DEFAULT 0,
      advance_days INTEGER DEFAULT 14,
      sheet_url TEXT DEFAULT '',
      questions JSONB DEFAULT '[]'::jsonb,
      waba_id TEXT DEFAULT '',
      flow_id TEXT DEFAULT '',
      flow_inbox_id INTEGER,
      flow_status TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await pool.query(`ALTER TABLE appt_settings ADD COLUMN IF NOT EXISTS waba_id TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE appt_settings ADD COLUMN IF NOT EXISTS flow_id TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE appt_settings ADD COLUMN IF NOT EXISTS flow_inbox_id INTEGER;`);
  await pool.query(`ALTER TABLE appt_settings ADD COLUMN IF NOT EXISTS flow_status TEXT DEFAULT '';`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appt_bookings (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      answers JSONB DEFAULT '{}'::jsonb,
      conversation_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (account_id, date, time)
    );`);
  console.log("DB tables ready");
}

export async function seedFlowIfEmpty(accountId, definition) {
  const { rows } = await pool.query(`SELECT id FROM flows WHERE account_id=$1 LIMIT 1`, [accountId]);
  if (rows.length === 0) { await pool.query(`INSERT INTO flows (account_id, name, definition, status, published_at) VALUES ($1,$2,$3,'published',NOW())`, [accountId, "Default flow", JSON.stringify(definition)]); console.log(`Seeded default flow for account ${accountId}`); }
}

export async function getPublishedFlowForInbox(accountId, inboxId) {
  if (inboxId == null) return null;
  const { rows } = await pool.query(`SELECT * FROM flows WHERE account_id=$1 AND inbox_id=$2 AND status='published' ORDER BY published_at DESC LIMIT 1`, [accountId, inboxId]);
  return rows[0] || null;
}

export async function listFlows(accountId) { const { rows } = await pool.query(`SELECT id, name, status, inbox_id, updated_at FROM flows WHERE account_id=$1 ORDER BY updated_at DESC`, [accountId]); return rows; }
export async function createFlow(accountId, name, inboxId) { const def = { start: null, nodes: {} }; const { rows } = await pool.query(`INSERT INTO flows (account_id, name, definition, status, inbox_id, published_at) VALUES ($1,$2,$3,'draft',$4,NULL) RETURNING *`, [accountId, name || "New chatbot", JSON.stringify(def), inboxId ?? null]); return rows[0]; }
export async function getFlowById(id) { const { rows } = await pool.query(`SELECT * FROM flows WHERE id=$1`, [id]); return rows[0] || null; }
export async function saveFlowById(id, name, definition) { const { rows } = await pool.query(`UPDATE flows SET name=COALESCE($2,name), definition=$3, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, name ?? null, JSON.stringify(definition)]); return rows[0] || null; }
export async function publishFlowById(id) {
  const cur = await getFlowById(id); if (!cur) return null;
  await pool.query(`UPDATE flows SET status='draft', updated_at=NOW() WHERE account_id=$1 AND id<>$2 AND inbox_id IS NOT DISTINCT FROM $3 AND status='published'`, [cur.account_id, id, cur.inbox_id]);
  const { rows } = await pool.query(`UPDATE flows SET status='published', published_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [id]);
  return rows[0];
}
export async function unpublishFlowById(id) { const { rows } = await pool.query(`UPDATE flows SET status='draft', updated_at=NOW() WHERE id=$1 RETURNING *`, [id]); return rows[0] || null; }
export async function deleteFlowById(id) { await pool.query(`DELETE FROM flows WHERE id=$1`, [id]); }
export async function assignInbox(id, inboxId) { const { rows } = await pool.query(`UPDATE flows SET inbox_id=$2, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, inboxId ?? null]); return rows[0] || null; }

export async function addMedia(accountId, filename, originalName, url, type, size) {
  const { rows } = await pool.query(`INSERT INTO media (account_id, filename, original_name, url, type, size) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [accountId, filename, originalName || null, url, type, size || null]);
  return rows[0];
}
export async function listMedia(accountId) { const { rows } = await pool.query(`SELECT id, original_name, url, type, size, created_at FROM media WHERE account_id=$1 ORDER BY created_at DESC`, [accountId]); return rows; }
export async function getMedia(id) { const { rows } = await pool.query(`SELECT * FROM media WHERE id=$1`, [id]); return rows[0] || null; }
export async function deleteMedia(id) { await pool.query(`DELETE FROM media WHERE id=$1`, [id]); }

export async function getSession(accountId, conversationId) { const { rows } = await pool.query(`SELECT * FROM bot_sessions WHERE account_id=$1 AND conversation_id=$2`, [accountId, conversationId]); return rows[0] || null; }
export async function saveSession(accountId, conversationId, s) {
  await pool.query(`INSERT INTO bot_sessions (account_id, conversation_id, node_id, awaiting, variables, flow_published_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (account_id, conversation_id) DO UPDATE SET node_id=$3, awaiting=$4, variables=$5, flow_published_at=$6, updated_at=NOW()`, [accountId, conversationId, s.nodeId, s.awaiting, JSON.stringify(s.variables || {}), s.flowPublishedAt]);
}

// ===== APPOINTMENTS (Google Sheets + self-tracked slots, no Calendar) =====

export async function getApptSettings(accountId) {
  const { rows } = await pool.query(`SELECT * FROM appt_settings WHERE account_id=$1`, [accountId]);
  return rows[0] || null;
}

export async function saveApptSettings(accountId, s) {
  const { rows } = await pool.query(`
    INSERT INTO appt_settings (account_id,working_days,start_time,end_time,slot_duration,buffer_time,advance_days,sheet_url,questions,waba_id,flow_id,flow_inbox_id,flow_status,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    ON CONFLICT (account_id) DO UPDATE SET
      working_days=$2,start_time=$3,end_time=$4,slot_duration=$5,buffer_time=$6,
      advance_days=$7,sheet_url=$8,questions=$9,
      waba_id=COALESCE($10, appt_settings.waba_id),
      flow_id=COALESCE($11, appt_settings.flow_id),
      flow_inbox_id=COALESCE($12, appt_settings.flow_inbox_id),
      flow_status=COALESCE($13, appt_settings.flow_status),
      updated_at=NOW()
    RETURNING *`,
    [accountId, s.working_days || '1,2,3,4,5', s.start_time || '09:00', s.end_time || '17:00',
     s.slot_duration || 30, s.buffer_time || 0, s.advance_days || 14,
     s.sheet_url || '', JSON.stringify(s.questions || []),
     s.waba_id ?? null, s.flow_id ?? null, s.flow_inbox_id ?? null, s.flow_status ?? null]);
  return rows[0];
}

export async function listApptBookings(accountId, date) {
  if (date) {
    const { rows } = await pool.query(`SELECT * FROM appt_bookings WHERE account_id=$1 AND date=$2 ORDER BY time`, [accountId, date]);
    return rows;
  }
  const { rows } = await pool.query(`SELECT * FROM appt_bookings WHERE account_id=$1 ORDER BY date, time`, [accountId]);
  return rows;
}

export async function getApptBookingBySlot(accountId, date, time) {
  const { rows } = await pool.query(`SELECT * FROM appt_bookings WHERE account_id=$1 AND date=$2 AND time=$3`, [accountId, date, time]);
  return rows[0] || null;
}

export async function createApptBooking(accountId, date, time, answers, conversationId) {
  const { rows } = await pool.query(
    `INSERT INTO appt_bookings (account_id, date, time, answers, conversation_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (account_id, date, time) DO NOTHING
     RETURNING *`,
    [accountId, date, time, JSON.stringify(answers || {}), conversationId || null]);
  return rows[0] || null;
}

export { pool };
