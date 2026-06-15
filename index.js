
import pg from "pg";
const { Pool } = pg;

// Coolify se DATABASE_URL env aayega (internal connection string)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// ---------- Tables banao (agar nahi hain) ----------
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
  console.log("DB tables ready ✅");
}

// ---------- Default flow seed karo (sirf agar account ka koi flow na ho) ----------
export async function seedFlowIfEmpty(accountId, definition) {
  const { rows } = await pool.query(
    `SELECT id FROM flows WHERE account_id = $1 LIMIT 1`,
    [accountId]
  );
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO flows (account_id, name, definition, status, published_at)
       VALUES ($1, $2, $3, 'published', NOW())`,
      [accountId, "Default flow", JSON.stringify(definition)]
    );
    console.log(`Seeded default flow for account ${accountId}`);
  }
}

// ---------- Published flow lao ----------
export async function getPublishedFlow(accountId) {
  const { rows } = await pool.query(
    `SELECT * FROM flows WHERE account_id = $1 AND status = 'published'
     ORDER BY published_at DESC LIMIT 1`,
    [accountId]
  );
  return rows[0] || null;
}

// ---------- Session lao ----------
export async function getSession(accountId, conversationId) {
  const { rows } = await pool.query(
    `SELECT * FROM bot_sessions WHERE account_id = $1 AND conversation_id = $2`,
    [accountId, conversationId]
  );
  return rows[0] || null;
}

// ---------- Session save karo (insert ya update) ----------
export async function saveSession(accountId, conversationId, s) {
  await pool.query(
    `INSERT INTO bot_sessions (account_id, conversation_id, node_id, awaiting, variables, flow_published_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (account_id, conversation_id)
     DO UPDATE SET node_id = $3, awaiting = $4, variables = $5, flow_published_at = $6, updated_at = NOW()`,
    [accountId, conversationId, s.nodeId, s.awaiting, JSON.stringify(s.variables || {}), s.flowPublishedAt]
  );
}

export { pool };
