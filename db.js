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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_settings (
      account_id INTEGER PRIMARY KEY,
      calendar_id TEXT DEFAULT '',
      slot_duration INTEGER DEFAULT 30,
      buffer_time INTEGER DEFAULT 0,
      start_time TEXT DEFAULT '09:00',
      end_time TEXT DEFAULT '17:00',
      working_days TEXT DEFAULT '1,2,3,4,5',
      advance_days INTEGER DEFAULT 14,
      timezone TEXT DEFAULT 'Asia/Karachi',
      apt_title TEXT DEFAULT 'Appointment',
      updated_at TIMESTAMPTZ DEFAULT NOW()
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

export async function getCalSettings(accountId) {
  const { rows } = await pool.query(`SELECT * FROM calendar_settings WHERE account_id=$1`, [accountId]);
  return rows[0] || null;
}
export async function saveCalSettings(accountId, s) {
  const { rows } = await pool.query(`
    INSERT INTO calendar_settings (account_id,calendar_id,slot_duration,buffer_time,start_time,end_time,working_days,advance_days,timezone,apt_title,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (account_id) DO UPDATE SET
      calendar_id=$2,slot_duration=$3,buffer_time=$4,start_time=$5,end_time=$6,
      working_days=$7,advance_days=$8,timezone=$9,apt_title=$10,updated_at=NOW()
    RETURNING *`,
    [accountId, s.calendar_id||'', s.slot_duration||30, s.buffer_time||0,
     s.start_time||'09:00', s.end_time||'17:00', s.working_days||'1,2,3,4,5',
     s.advance_days||14, s.timezone||'Asia/Karachi', s.apt_title||'Appointment']);
  return rows[0];
}

export { pool };
