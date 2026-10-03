// Port of ApiTokenService + ApiToken model.
const crypto = require('crypto');
const db = require('../core/db');

const PREFIX = 'hams_';

function generateRawToken() {
  return PREFIX + crypto.randomBytes(24).toString('hex'); // hams_ + 48 hex chars
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function maskToken(raw) {
  if (raw.length <= 12) return raw;
  return raw.slice(0, 10) + '*'.repeat(raw.length - 14) + raw.slice(-4);
}

function expiryFor(expiresIn) {
  const map = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  if (!map[expiresIn]) return null;
  const d = new Date();
  d.setDate(d.getDate() + map[expiresIn]);
  return d;
}

async function createForUser(userId, name, abilities, expiresAt) {
  const raw = generateRawToken();
  const hash = hashToken(raw);
  const abilitiesJson = abilities && abilities.length ? JSON.stringify(abilities) : null;
  await db.insert(
    'INSERT INTO api_tokens (user_id, name, token_hash, abilities, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [userId, name, hash, abilitiesJson, expiresAt]);
  return { raw_token: raw, name, expires_at: expiresAt, abilities };
}

async function listForUser(userId) {
  const rows = await db.query('SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return rows.map(t => {
    let abilities = t.abilities;
    if (typeof abilities === 'string') { try { abilities = JSON.parse(abilities); } catch (_) { abilities = null; } }
    return {
      ...t,
      masked_token: maskToken(PREFIX + String(t.token_hash).slice(0, 32)),
      is_revoked: t.revoked_at !== null,
      is_expired: !!(t.expires_at && new Date(t.expires_at).getTime() < Date.now()),
      abilities_array: abilities
    };
  });
}

async function findById(id) {
  return db.get('SELECT * FROM api_tokens WHERE id = $1', [id]);
}

async function revoke(id) {
  await db.run('UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [id]);
  return true;
}

async function pruneExpired() {
  const res = await db.run('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < NOW()');
  return res.rowCount;
}

module.exports = { generateRawToken, hashToken, maskToken, expiryFor, createForUser, listForUser, findById, revoke, pruneExpired };
