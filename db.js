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
  // NEW: har flow ek inbox se bandh sakta hai (B). Purani table ko bhi migrate karo.
  await pool.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS inbox_id INTEGER;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      node_id TEXT,
      awaiting TEXT,
      variables JSONB NOT NULL DEFAULT '{}'::jsonb,
      flow_published_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (account_id, conversation_id)
    );
  `);
  console.log("DB tables ready");
}

export async function seedFlowIfEmpty(accountId, definition) {
  const { rows } = await pool.query(`SELECT id FROM flows WHERE account_id = $1 LIMIT 1`, [accountId]);
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO flows (account_id, name, definition, status, published_at)
       VALUES ($1, $2, $3, 'published', NOW())`,
      [accountId, "Default flow", JSON.stringify(definition)]
    );
    console.log(`Seeded default flow for account ${accountId}`);
  }
}

// Engine: us inbox ka published flow; na mile to default (inbox_id NULL) flow
export async function getPublishedFlowForInbox(accountId, inboxId) {
  if (inboxId != null) {
    const { rows } = await pool.query(
      `SELECT * FROM flows WHERE account_id=$1 AND inbox_id=$2 AND status='published'
       ORDER BY published_at DESC LIMIT 1`,
      [accountId, inboxId]
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT * FROM flows WHERE account_id=$1 AND inbox_id IS NULL AND status='published'
     ORDER BY published_at DESC LIMIT 1`,
    [accountId]
  );
  return rows[0] || null;
}

// (purana — builder abhi bhi use karta) account ka editable flow
export async function getFlowForEditing(accountId) {
  const { rows } = await pool.query(
    `SELECT * FROM flows WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1`, [accountId]
  );
  return rows[0] || null;
}
export async function saveFlow(accountId, name, definition, publish) {
  const existing = await getFlowForEditing(accountId);
  const status = publish ? "published" : "draft";
  if (existing) {
    const { rows } = await pool.query(
      `UPDATE flows SET name=$2, definition=$3, status=$4, updated_at=NOW(),
         published_at = CASE WHEN $5 THEN NOW() ELSE published_at END
       WHERE id=$1 RETURNING *`,
      [existing.id, name || existing.name, JSON.stringify(definition), status, !!publish]
    );
    return rows[0];
  } else {
    const { rows } = await pool.query(
      `INSERT INTO flows (account_id, name, definition, status, published_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN NOW() ELSE NULL END) RETURNING *`,
      [accountId, name || "My flow", JSON.stringify(definition), status, !!publish]
    );
    return rows[0];
  }
}
export async function publishFlow(accountId) {
  const existing = await getFlowForEditing(accountId);
  if (!existing) return null;
  const { rows } = await pool.query(
    `UPDATE flows SET status='published', published_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
    [existing.id]
  );
  return rows[0];
}

export async function getSession(accountId, conversationId) {
  const { rows } = await pool.query(
    `SELECT * FROM bot_sessions WHERE account_id=$1 AND conversation_id=$2`, [accountId, conversationId]
  );
  return rows[0] || null;
}
export async function saveSession(accountId, conversationId, s) {
  await pool.query(
    `INSERT INTO bot_sessions (account_id, conversation_id, node_id, awaiting, variables, flow_published_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (account_id, conversation_id)
     DO UPDATE SET node_id=$3, awaiting=$4, variables=$5, flow_published_at=$6, updated_at=NOW()`,
    [accountId, conversationId, s.nodeId, s.awaiting, JSON.stringify(s.variables || {}), s.flowPublishedAt]
  );
}

export { pool };
