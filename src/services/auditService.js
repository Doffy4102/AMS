// Port of AuditService
const db = require('../core/db');

async function log(userId, action, description) {
  try {
    await db.run(
      'INSERT INTO activity_logs (user_id, action, description) VALUES ($1, $2, $3)',
      [userId || null, action, description]
    );
    return true;
  } catch (_) {
    return false;
  }
}

async function getLogs(limit = 1000, offset = 0) {
  limit = Math.min(Math.max(1, limit), 5000);
  offset = Math.max(0, offset);
  return db.query(
    `SELECT l.*, u.name AS user_name FROM activity_logs l
     LEFT JOIN users u ON l.user_id = u.id
     ORDER BY l.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}

module.exports = { log, getLogs };
