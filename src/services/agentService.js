// Endpoint-agent service: enrollment-key management, agent enrollment (system
// details -> asset), and heartbeat ingestion. Follows the codebase service style
// (flat async functions over core/db). Agent-reported health reuses the existing
// heartbeat tables via heartbeatService.recordResult (check_method 'agent').
const crypto = require('crypto');
const db = require('../core/db');
const heartbeatService = require('./heartbeat/heartbeatService');

// An agent is "online" if it has beaten within 20 min, "stale" up to 45 min,
// "offline" beyond that. Cadence is 15 min, so 20 min tolerates one late beat.
const ONLINE_MIN = 20;
const STALE_MIN = 45;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const num = v => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v, max = 255) => (v === undefined || v === null ? null : String(v).slice(0, max));

// ---- enrollment keys ----
async function getActiveKey() {
  let key = await db.get('SELECT * FROM agent_enrollment_keys WHERE is_active = TRUE ORDER BY id DESC LIMIT 1');
  if (!key) {
    const value = 'HAMS-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    const id = await db.insert(
      'INSERT INTO agent_enrollment_keys (enrollment_key, label) VALUES ($1, $2)',
      [value, 'Default enrollment key']);
    key = await db.get('SELECT * FROM agent_enrollment_keys WHERE id = $1', [id]);
  }
  return key;
}

async function regenerateKey(label = 'Default enrollment key') {
  const value = 'HAMS-' + crypto.randomBytes(12).toString('hex').toUpperCase();
  await db.run('UPDATE agent_enrollment_keys SET is_active = FALSE WHERE is_active = TRUE');
  const id = await db.insert(
    'INSERT INTO agent_enrollment_keys (enrollment_key, label) VALUES ($1, $2)', [value, label]);
  return db.get('SELECT * FROM agent_enrollment_keys WHERE id = $1', [id]);
}

async function isValidEnrollmentKey(key) {
  if (!key) return false;
  const row = await db.get(
    'SELECT id FROM agent_enrollment_keys WHERE enrollment_key = $1 AND is_active = TRUE', [key]);
  return !!row;
}

// ---- asset linking (match by serial, else create) ----
async function resolveAssetId(payload, t) {
  const serial = str(payload.serial_number, 100);
  if (serial) {
    const existing = await t.get('SELECT id FROM assets WHERE serial_number = $1 AND deleted_at IS NULL', [serial]);
    if (existing) return existing.id;
  }
  // Create a new asset for this machine.
  const category = str(payload.asset_type, 100) || 'Laptop';
  const name = str(payload.hostname, 255) || (payload.model ? str(payload.model, 255) : 'Endpoint Device');
  const idRow = await t.get('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM assets');
  const tag = 'HAMS-' + String(idRow.next).padStart(6, '0');
  const token = crypto.randomBytes(16).toString('hex');
  const assetId = await t.insert(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category, status, category_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'available',
             (SELECT id FROM asset_categories WHERE name = $7 LIMIT 1))`,
    [tag, token, name, serial, str(payload.model, 100), category, category]);
  return assetId;
}

// ---- enroll ----
// Returns { agent_uid, token, asset_id }. Idempotent per serial+hostname: a
// re-enroll rotates the token instead of duplicating the agent.
async function enroll(payload = {}, ip = null) {
  return db.tx(async t => {
    const assetId = await resolveAssetId(payload, t);
    const token = 'hams_agent_' + crypto.randomBytes(24).toString('hex');
    const tokenHash = sha256(token);
    const platform = ['windows', 'mac', 'linux'].includes(payload.platform) ? payload.platform : 'unknown';

    // Reuse an existing agent row for the same machine if present.
    const serial = str(payload.serial_number, 120);
    const hostname = str(payload.hostname, 255);
    let existing = null;
    if (serial) existing = await t.get('SELECT id, agent_uid FROM agents WHERE serial_number = $1 ORDER BY id LIMIT 1', [serial]);
    if (!existing && hostname) existing = await t.get('SELECT id, agent_uid FROM agents WHERE hostname = $1 ORDER BY id LIMIT 1', [hostname]);

    const fields = {
      asset_id: assetId, platform, hostname,
      os: str(payload.os, 120), os_version: str(payload.os_version, 120),
      cpu_model: str(payload.cpu_model, 255), cpu_cores: num(payload.cpu_cores),
      ram_mb: num(payload.ram_mb), disk_total_gb: num(payload.disk_total_gb),
      disk_free_gb: num(payload.disk_free_gb), mac_address: str(payload.mac_address, 64),
      ip_address: str(payload.ip_address, 64) || ip, logged_in_user: str(payload.logged_in_user, 150),
      serial_number: serial, manufacturer: str(payload.manufacturer, 150), model: str(payload.model, 150),
      agent_version: str(payload.agent_version, 20), uptime_sec: num(payload.uptime_sec)
    };

    let agentUid;
    if (existing) {
      agentUid = existing.agent_uid;
      await t.run(
        `UPDATE agents SET token_hash = $2, asset_id = $3, platform = $4, hostname = $5, os = $6,
           os_version = $7, cpu_model = $8, cpu_cores = $9, ram_mb = $10, disk_total_gb = $11,
           disk_free_gb = $12, mac_address = $13, ip_address = $14, logged_in_user = $15,
           serial_number = $16, manufacturer = $17, model = $18, agent_version = $19,
           uptime_sec = $20, last_heartbeat_at = NOW(), heartbeat_count = agents.heartbeat_count + 1
         WHERE id = $1`,
        [existing.id, tokenHash, fields.asset_id, fields.platform, fields.hostname, fields.os,
         fields.os_version, fields.cpu_model, fields.cpu_cores, fields.ram_mb, fields.disk_total_gb,
         fields.disk_free_gb, fields.mac_address, fields.ip_address, fields.logged_in_user,
         fields.serial_number, fields.manufacturer, fields.model, fields.agent_version, fields.uptime_sec]);
    } else {
      agentUid = crypto.randomBytes(16).toString('hex');
      await t.run(
        `INSERT INTO agents (agent_uid, token_hash, asset_id, platform, hostname, os, os_version,
           cpu_model, cpu_cores, ram_mb, disk_total_gb, disk_free_gb, mac_address, ip_address,
           logged_in_user, serial_number, manufacturer, model, agent_version, uptime_sec,
           last_heartbeat_at, heartbeat_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, NOW(), 1)`,
        [agentUid, tokenHash, fields.asset_id, fields.platform, fields.hostname, fields.os,
         fields.os_version, fields.cpu_model, fields.cpu_cores, fields.ram_mb, fields.disk_total_gb,
         fields.disk_free_gb, fields.mac_address, fields.ip_address, fields.logged_in_user,
         fields.serial_number, fields.manufacturer, fields.model, fields.agent_version, fields.uptime_sec]);
    }

    // Register/refresh the health monitor (method 'agent') and mark UP.
    await t.run(
      `INSERT INTO asset_monitors (asset_id, hostname, ip_address, check_method, monitoring_enabled)
       VALUES ($1, $2, $3, 'agent', TRUE)
       ON CONFLICT (asset_id) DO UPDATE SET
         hostname = EXCLUDED.hostname, ip_address = EXCLUDED.ip_address,
         check_method = 'agent', monitoring_enabled = TRUE, updated_at = NOW()`,
      [assetId, fields.hostname, fields.ip_address]);
    await t.run(
      `INSERT INTO asset_health_status
         (asset_id, status, latency_ms, check_method, target, error, consecutive_failures, last_checked_at, last_change_at)
       VALUES ($1, 'UP', NULL, 'agent', $2, NULL, 0, NOW(), NOW())
       ON CONFLICT (asset_id) DO UPDATE SET
         status = 'UP', check_method = 'agent', target = EXCLUDED.target, error = NULL,
         consecutive_failures = 0, last_checked_at = NOW(),
         last_change_at = CASE WHEN asset_health_status.status IS DISTINCT FROM 'UP'
                               THEN NOW() ELSE asset_health_status.last_change_at END`,
      [assetId, fields.hostname || fields.ip_address]);

    return { agent_uid: agentUid, token, asset_id: assetId };
  });
}

// ---- heartbeat ----
async function heartbeat(token, payload = {}, ip = null) {
  if (!token) return { ok: false, code: 401, error: 'Missing agent token' };
  const agent = await db.get('SELECT * FROM agents WHERE token_hash = $1', [sha256(token)]);
  if (!agent) return { ok: false, code: 401, error: 'Invalid agent token' };

  await db.run(
    `UPDATE agents SET last_heartbeat_at = NOW(), heartbeat_count = heartbeat_count + 1,
       ip_address = COALESCE($2, ip_address), logged_in_user = COALESCE($3, logged_in_user),
       uptime_sec = COALESCE($4, uptime_sec), disk_free_gb = COALESCE($5, disk_free_gb)
     WHERE id = $1`,
    [agent.id, str(payload.ip_address, 64) || ip, str(payload.logged_in_user, 150),
     num(payload.uptime_sec), num(payload.disk_free_gb)]);

  await db.run(
    `INSERT INTO agent_metrics (agent_id, cpu_percent, ram_used_mb, disk_free_gb, uptime_sec, ip_address, logged_in_user)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [agent.id, num(payload.cpu_percent), num(payload.ram_used_mb), num(payload.disk_free_gb),
     num(payload.uptime_sec), str(payload.ip_address, 64) || ip, str(payload.logged_in_user, 150)]);

  // Update health status via the shared recorder (marks UP, appends history,
  // auto-resolves any open down-alert).
  if (agent.asset_id) {
    await heartbeatService.recordResult({
      assetId: agent.asset_id, ok: true, latencyMs: num(payload.latency_ms),
      error: null, checkMethod: 'agent', target: agent.hostname || agent.ip_address
    });
  }
  return { ok: true, agent_id: agent.id, interval_sec: 900 };
}

// ---- read API for the UI ----
function statusExpr(alias = 'a') {
  return `CASE
      WHEN ${alias}.last_heartbeat_at IS NULL THEN 'offline'
      WHEN ${alias}.last_heartbeat_at > NOW() - INTERVAL '${ONLINE_MIN} minutes' THEN 'online'
      WHEN ${alias}.last_heartbeat_at > NOW() - INTERVAL '${STALE_MIN} minutes' THEN 'stale'
      ELSE 'offline' END`;
}

async function listAgents() {
  return db.query(
    `SELECT a.*, ${statusExpr('a')} AS live_status,
            ast.name AS asset_name, ast.asset_tag,
            l.name AS location
       FROM agents a
       LEFT JOIN assets ast ON ast.id = a.asset_id
       LEFT JOIN locations l ON l.id = ast.location_id
      ORDER BY a.last_heartbeat_at DESC NULLS LAST, a.id DESC`);
}

async function agentStats() {
  const row = await db.get(
    `SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE last_heartbeat_at > NOW() - INTERVAL '${ONLINE_MIN} minutes') AS online,
       COUNT(*) FILTER (WHERE last_heartbeat_at > NOW() - INTERVAL '${STALE_MIN} minutes'
                          AND last_heartbeat_at <= NOW() - INTERVAL '${ONLINE_MIN} minutes') AS stale,
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NULL
                          OR last_heartbeat_at <= NOW() - INTERVAL '${STALE_MIN} minutes') AS offline
     FROM agents`);
  return {
    total: parseInt(row.total || 0), online: parseInt(row.online || 0),
    stale: parseInt(row.stale || 0), offline: parseInt(row.offline || 0)
  };
}

async function getAgent(id) {
  const agent = await db.get(
    `SELECT a.*, ${statusExpr('a')} AS live_status, ast.name AS asset_name, ast.asset_tag
       FROM agents a LEFT JOIN assets ast ON ast.id = a.asset_id WHERE a.id = $1`, [id]);
  if (!agent) return null;
  agent.metrics = await db.query(
    'SELECT * FROM agent_metrics WHERE agent_id = $1 ORDER BY reported_at DESC LIMIT 50', [id]);
  return agent;
}

module.exports = {
  getActiveKey, regenerateKey, isValidEnrollmentKey,
  enroll, heartbeat, listAgents, agentStats, getAgent,
  ONLINE_MIN, STALE_MIN
};
