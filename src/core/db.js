const { Pool } = require('pg');
const config = require('../config');

const pool = config.databaseUrl
  ? new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 10
  })
  : new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ...(config.db.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 10
  });

// Numeric/decimal columns come back as strings by default; leave as-is (views format them).

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const res = await pool.query(sql, params);
  return res; // rowCount, rows
}

// Insert helper returning the new id
async function insert(sql, params = []) {
  const res = await pool.query(sql + ' RETURNING id', params);
  return res.rows[0] ? res.rows[0].id : null;
}

// Transaction helper: fn receives a client-scoped API {query, get, run, insert}
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const api = {
      query: async (sql, params = []) => (await client.query(sql, params)).rows,
      get: async (sql, params = []) => ((await client.query(sql, params)).rows[0] || null),
      run: async (sql, params = []) => client.query(sql, params),
      insert: async (sql, params = []) => {
        const res = await client.query(sql + ' RETURNING id', params);
        return res.rows[0] ? res.rows[0].id : null;
      }
    };
    const result = await fn(api);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, get, run, insert, tx };
