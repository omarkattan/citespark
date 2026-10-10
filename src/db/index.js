import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Render managed Postgres requires TLS. Local dev usually does not.
const needsSsl = /render\.com|amazonaws|supabase|neon\.tech/.test(connectionString);

export const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  max: 10
});

// pg emits errors outside query promises when a socket dies between queries.
// Both checked-out clients and idle pooled clients need listeners.
pool.on('connect', client => {
  client.on('error', error => console.error('Database client connection lost:', error.code || 'connection_closed'));
});
pool.on('error', error => console.error('Database pool connection lost:', error.code || 'connection_closed'));

export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

export async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

export async function many(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
