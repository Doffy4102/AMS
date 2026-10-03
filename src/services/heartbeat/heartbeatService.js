// Data layer for the Asset Health Check (heartbeat) agent.
// Follows the codebase service style: flat async functions over core/db, with a
// factory (createHeartbeatService) so unit tests can inject a fake db.
const realDb = require('../../core/db');

// Pure state-transition rule: alerts fire ONLY on UP->DOWN ('down') and
// DOWN->UP ('recovered'). UNKNOWN transitions (first check) change state but do
// not alert; unchanged status never alerts (no duplicates).
function evaluateTransition(prevStatus, newStatus) {
  const from = prevStatus || 'UNKNOWN';
  if (from === newStatus) return { changed: false, alert: null };
  if (from === 'UP' && newStatus === 'DOWN') return { changed: true, alert: 'down' };
  if (from === 'DOWN' && newStatus === 'UP') return { changed: true, alert: 'recovered' };
  return { changed: true, alert: null }; // UNKNOWN -> UP/DOWN
}

function createHeartbeatService(db = realDb) {
  // Monitored assets = asset_monitors joined to the live asset row (+ assignee,
  // location) so the agent carries asset context without extra queries.
  async function loadMonitoredAssets() {
    return db.query(
      `SELECT m.asset_id, m.hostname, m.ip_address, m.check_method, m.port, m.health_url,
              a.name AS asset_name, a.asset_tag, a.category AS asset_type,
              u.name AS assigned_user, l.name AS location
         FROM asset_monitors m
         JOIN assets a ON a.id = m.asset_id AND a.deleted_at IS NULL
         LEFT JOIN users u ON u.id = a.assigned_to
         LEFT JOIN locations l ON l.id = a.location_id
        WHERE m.monitoring_enabled = TRUE
        ORDER BY m.asset_id`);
  }

  // Persist one check result: upsert current status, append history, and on a
  // state change create the alert record (recovery auto-resolves open down-alerts).
  // Returns { status, transition } so the agent can log state changes.
  async function recordResult(result) {
    const { assetId, ok, latencyMs, error, checkMethod, target } = result;
    const newStatus = ok ? 'UP' : 'DOWN';
    return db.tx(async t => {
      const prev = await t.get('SELECT status, consecutive_failures FROM asset_health_status WHERE asset_id = $1', [assetId]);
      const transition = evaluateTransition(prev ? prev.status : null, newStatus);
      const failures = ok ? 0 : ((prev ? prev.consecutive_failures : 0) + 1);

      await t.run(
        `INSERT INTO asset_health_status
           (asset_id, status, latency_ms, check_method, target, error, consecutive_failures, last_checked_at, last_change_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (asset_id) DO UPDATE SET
           status = EXCLUDED.status, latency_ms = EXCLUDED.latency_ms,
           check_method = EXCLUDED.check_method, target = EXCLUDED.target,
           error = EXCLUDED.error, consecutive_failures = EXCLUDED.consecutive_failures,
           last_checked_at = NOW(),
           last_change_at = CASE WHEN asset_health_status.status IS DISTINCT FROM EXCLUDED.status
                                 THEN NOW() ELSE asset_health_status.last_change_at END`,
        [assetId, newStatus, latencyMs, checkMethod, target, error || null, failures]);

      await t.run(
        `INSERT INTO asset_heartbeats (asset_id, status, latency_ms, check_method, target, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [assetId, newStatus, latencyMs, checkMethod, target, error || null]);

      if (transition.alert === 'down') {
        await t.run(
          `INSERT INTO heartbeat_alerts (asset_id, alert_type, previous_status, current_status, message)
           VALUES ($1, 'down', 'UP', 'DOWN', $2)`,
          [assetId, `Asset went DOWN (${checkMethod} ${target}): ${error || 'no response'}`]);
      } else if (transition.alert === 'recovered') {
        await t.run(
          `INSERT INTO heartbeat_alerts (asset_id, alert_type, previous_status, current_status, message)
           VALUES ($1, 'recovered', 'DOWN', 'UP', $2)`,
          [assetId, `Asset recovered (${checkMethod} ${target}), latency ${latencyMs != null ? latencyMs + 'ms' : 'n/a'}`]);
        await t.run(
          `UPDATE heartbeat_alerts SET is_resolved = TRUE, resolved_at = NOW()
            WHERE asset_id = $1 AND alert_type = 'down' AND is_resolved = FALSE`, [assetId]);
      }
      return { status: newStatus, transition };
    });
  }

  // ---- read API ----
  async function listCurrentStatuses() {
    return db.query(
      `SELECT s.*, a.name AS asset_name, a.asset_tag, a.category AS asset_type,
              u.name AS assigned_user, l.name AS location
         FROM asset_health_status s
         JOIN assets a ON a.id = s.asset_id
         LEFT JOIN users u ON u.id = a.assigned_to
         LEFT JOIN locations l ON l.id = a.location_id
        ORDER BY s.status DESC, a.name`);
  }

  async function getStatus(assetId) {
    return db.get(
      `SELECT s.*, a.name AS asset_name, a.asset_tag, a.category AS asset_type,
              u.name AS assigned_user, l.name AS location
         FROM asset_health_status s
         JOIN assets a ON a.id = s.asset_id
         LEFT JOIN users u ON u.id = a.assigned_to
         LEFT JOIN locations l ON l.id = a.location_id
        WHERE s.asset_id = $1`, [assetId]);
  }

  async function history(assetId, limit = 100) {
    return db.query(
      `SELECT id, asset_id, status, latency_ms, check_method, target, error, checked_at
         FROM asset_heartbeats WHERE asset_id = $1
        ORDER BY checked_at DESC LIMIT $2`, [assetId, Math.min(limit, 1000)]);
  }

  async function unresolvedAlerts() {
    return db.query(
      `SELECT al.*, a.name AS asset_name, a.asset_tag
         FROM heartbeat_alerts al JOIN assets a ON a.id = al.asset_id
        WHERE al.is_resolved = FALSE ORDER BY al.created_at DESC`);
  }

  async function resolveAlert(id) {
    const res = await db.run(
      'UPDATE heartbeat_alerts SET is_resolved = TRUE, resolved_at = NOW() WHERE id = $1 AND is_resolved = FALSE', [id]);
    return res.rowCount > 0;
  }

  // Configure (or reconfigure) monitoring for an asset.
  async function upsertMonitor(assetId, data = {}) {
    const method = ['icmp', 'tcp', 'http'].includes(data.check_method) ? data.check_method : 'icmp';
    await db.run(
      `INSERT INTO asset_monitors (asset_id, hostname, ip_address, check_method, port, health_url, monitoring_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (asset_id) DO UPDATE SET
         hostname = EXCLUDED.hostname, ip_address = EXCLUDED.ip_address,
         check_method = EXCLUDED.check_method, port = EXCLUDED.port,
         health_url = EXCLUDED.health_url, monitoring_enabled = EXCLUDED.monitoring_enabled,
         updated_at = NOW()`,
      [assetId, data.hostname || null, data.ip_address || null, method,
        data.port || null, data.health_url || null, data.monitoring_enabled !== false]);
    return true;
  }

  // Analytics: aggregate health stats
  async function getHealthStats() {
    const result = await db.get(
      `SELECT
         COUNT(*) FILTER (WHERE status IS NOT NULL) as total_monitored,
         COUNT(*) FILTER (WHERE status = 'UP') as online_count,
         COUNT(*) FILTER (WHERE status = 'DOWN') as offline_count,
         COUNT(*) FILTER (WHERE status = 'UNSTABLE') as unstable_count,
         ROUND(AVG(NULLIF(latency_ms, 0))::numeric, 2) as avg_latency
       FROM asset_health_status`);
    return {
      totalMonitored: parseInt(result.total_monitored || 0),
      online: parseInt(result.online_count || 0),
      offline: parseInt(result.offline_count || 0),
      unstable: parseInt(result.unstable_count || 0),
      avgLatency: parseFloat(result.avg_latency || 0)
    };
  }

  // Get latency trend (last 24 hours, hourly)
  async function getLatencyTrend() {
    return db.query(
      `SELECT
         DATE_TRUNC('hour', checked_at) as hour,
         ROUND(AVG(NULLIF(latency_ms, 0))::numeric, 2) as avg_latency
       FROM asset_heartbeats
       WHERE checked_at > NOW() - INTERVAL '24 hours'
       GROUP BY DATE_TRUNC('hour', checked_at)
       ORDER BY hour DESC
       LIMIT 24`);
  }

  // Get recent status changes (alerts)
  async function getRecentAlerts(limit = 10) {
    return db.query(
      `SELECT al.*, a.name AS asset_name, a.asset_tag, a.category AS asset_type
         FROM heartbeat_alerts al
         JOIN assets a ON a.id = al.asset_id
        ORDER BY al.created_at DESC
        LIMIT $1`, [limit]);
  }

  // Get detailed asset status with all metadata
  async function getDetailedAssetStatus(filters = {}) {
    let query = `
      SELECT
        s.asset_id, s.status, s.latency_ms, s.consecutive_failures,
        s.last_checked_at, s.last_change_at, s.check_method, s.target, s.error,
        a.name AS asset_name, a.asset_tag, a.category AS asset_type,
        u.name AS assigned_user, l.name AS location,
        m.hostname, m.ip_address
      FROM asset_health_status s
      JOIN assets a ON a.id = s.asset_id
      LEFT JOIN users u ON u.id = a.assigned_to
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN asset_monitors m ON m.asset_id = a.id
      WHERE s.status IS NOT NULL`;

    const params = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND s.status = $${paramCount++}`;
      params.push(filters.status);
    }
    if (filters.location_id) {
      query += ` AND a.location_id = $${paramCount++}`;
      params.push(filters.location_id);
    }
    if (filters.asset_type) {
      query += ` AND a.category = $${paramCount++}`;
      params.push(filters.asset_type);
    }
    if (filters.search) {
      const searchTerm = `%${filters.search}%`;
      query += ` AND (a.name ILIKE $${paramCount} OR m.hostname ILIKE $${paramCount} OR m.ip_address ILIKE $${paramCount} OR a.asset_tag ILIKE $${paramCount})`;
      params.push(searchTerm);
      paramCount++;
    }

    query += ` ORDER BY s.status DESC, a.name ASC`;
    return db.query(query, params);
  }

  return {
    loadMonitoredAssets, recordResult, listCurrentStatuses, getStatus,
    history, unresolvedAlerts, resolveAlert, upsertMonitor,
    getHealthStats, getLatencyTrend, getRecentAlerts, getDetailedAssetStatus
  };
}

module.exports = { ...createHeartbeatService(), createHeartbeatService, evaluateTransition };
