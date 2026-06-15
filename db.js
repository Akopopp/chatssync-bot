import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flows (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT 'Default flow',
      definition JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      published_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS inbox_id INTEGER;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      node_id TEXT, awaiting TEXT,
      variables JSONB NOT NULL DEFAULT '{}'::jsonb,
      flow_published_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (account_id, conversation_id)
    );
  `);
  console.log("DB tables ready");
}

export async function seedFlowIfEmpty(accountId, definition) {
  const { rows } = await pool.query(`SELECT id FROM flows WHERE account_id=$1 LIMIT 1`, [accountId]);
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO flows (account_id, name, definition, status, published_at)
       VALUES ($1,$2,$3,'published',NOW())`,
      [accountId, "Default flow", JSON.stringify(definition)]
    );
    console.log(`Seeded default flow for account ${accountId}`);
  }
}

// Engine routing (B): inbox ka published flow; na mile to default (inbox NULL)
export async function getPublishedFlowForInbox(accountId, inboxId) {
  if (inboxId != null) {
    const { rows } = await pool.query(
      `SELECT * FROM flows WHERE account_id=$1 AND inbox_id=$2 AND status='published'
       ORDER BY published_at DESC LIMIT 1`, [accountId, inboxId]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT * FROM flows WHERE account_id=$1 AND inbox_id IS NULL AND status='published'
     ORDER BY published_at DESC LIMIT 1`, [accountId]);
  return rows[0] || null;
}

// ===== MULTI-FLOW (dashboard) =====
export async function listFlows(accountId) {
  const { rows } = await pool.query(
    `SELECT id, name, status, inbox_id, updated_at FROM flows
     WHERE account_id=$1 ORDER BY updated_at DESC`, [accountId]);
  return rows;
}
export async function createFlow(accountId, name, inboxId) {
  const def = { start: null, nodes: {} };
  const { rows } = await pool.query(
    `INSERT INTO flows (account_id, name, definition, status, inbox_id, published_at)
     VALUES ($1,$2,$3,'draft',$4,NULL) RETURNING *`,
    [accountId, name || "New chatbot", JSON.stringify(def), inboxId ?? null]);
  return rows[0];
}
export async function getFlowById(id) {
  const { rows } = await pool.query(`SELECT * FROM flows WHERE id=$1`, [id]);
  return rows[0] || null;
}
export async function saveFlowById(id, name, definition) {
  const { rows } = await pool.query(
    `UPDATE flows SET name=COALESCE($2,name), definition=$3, updated_at=NOW()
     WHERE id=$1 RETURNING *`, [id, name ?? null, JSON.stringify(definition)]);
  return rows[0] || null;
}
export async function publishFlowById(id) {
  const cur = await getFlowById(id);
  if (!cur) return null;
  // ek inbox par ek hi live: same inbox ke baaki draft kar do
  await pool.query(
    `UPDATE flows SET status='draft', updated_at=NOW()
     WHERE account_id=$1 AND id<>$2 AND inbox_id IS NOT DISTINCT FROM $3 AND status='published'`,
    [cur.account_id, id, cur.inbox_id]);
  const { rows } = await pool.query(
    `UPDATE flows SET status='published', published_at=NOW(), updated_at=NOW()
     WHERE id=$1 RETURNING *`, [id]);
  return rows[0];
}
export async function unpublishFlowById(id) {
  const { rows } = await pool.query(
    `UPDATE flows SET status='draft', updated_at=NOW() WHERE id=$1 RETURNING *`, [id]);
  return rows[0] || null;
}
export async function deleteFlowById(id) {
  await pool.query(`DELETE FROM flows WHERE id=$1`, [id]);
}
export async function assignInbox(id, inboxId) {
  const { rows } = await pool.query(
    `UPDATE flows SET inbox_id=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, inboxId ?? null]);
  return rows[0] || null;
}

// ===== sessions =====
export async function getSession(accountId, conversationId) {
  const { rows } = await pool.query(
    `SELECT * FROM bot_sessions WHERE account_id=$1 AND conversation_id=$2`,
    [accountId, conversationId]);
  return rows[0] || null;
}
export async function saveSession(accountId, conversationId, s) {
  await pool.query(
    `INSERT INTO bot_sessions (account_id, conversation_id, node_id, awaiting, variables, flow_published_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (account_id, conversation_id)
     DO UPDATE SET node_id=$3, awaiting=$4, variables=$5, flow_published_at=$6, updated_at=NOW()`,
    [accountId, conversationId, s.nodeId, s.awaiting, JSON.stringify(s.variables || {}), s.flowPublishedAt]);
}

export { pool };
