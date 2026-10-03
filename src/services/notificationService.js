// Port of NotificationService: in-app notifications + optional outbound webhook.
const db = require('../core/db');
const settings = require('./settingsService');

async function send(userId, type, subject, message) {
  await db.run(
    `INSERT INTO notifications (user_id, type, subject, message, delivery_status)
     VALUES ($1, $2, $3, $4, 'sent')`,
    [userId || null, type, subject, message]
  );
  try { await sendWebhook({ user_id: userId, type, subject, message, created_at: new Date().toISOString() }); } catch (_) {}
  return true;
}

async function sendWebhook(payload) {
  const enabled = await settings.get('notifications', 'webhook_enabled');
  const url = await settings.get('notifications', 'webhook_url', '');
  if (enabled !== '1' || !url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function adminUsers() {
  return db.query(
    `SELECT DISTINCT u.id, u.name, u.email FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.deleted_at IS NULL
       AND (u.role IN ('super_admin', 'it_admin') OR r.name IN ('super_admin', 'it_admin'))`
  );
}

async function sendToAdmins(type, subject, message) {
  const admins = await adminUsers();
  if (admins.length === 0) {
    await send(null, type, subject, message);
    return 1;
  }
  for (const admin of admins) {
    await send(admin.id, type, subject, message);
  }
  return admins.length;
}

async function getUnreadCount(userId) {
  const row = await db.get(
    `SELECT COUNT(*)::int AS c FROM notifications n
     WHERE (n.user_id = $1 OR n.user_id IS NULL)
       AND ((n.user_id IS NOT NULL AND n.is_read = FALSE)
         OR (n.user_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM notification_reads nr WHERE nr.notification_id = n.id AND nr.user_id = $1)))`,
    [userId]
  );
  return row ? row.c : 0;
}

async function getLatest(userId, limit = 10) {
  return db.query(
    `SELECT n.*,
            CASE WHEN n.user_id IS NULL THEN
              (CASE WHEN EXISTS (SELECT 1 FROM notification_reads nr WHERE nr.notification_id = n.id AND nr.user_id = $1) THEN TRUE ELSE FALSE END)
            ELSE n.is_read END AS is_read
     FROM notifications n
     WHERE n.user_id = $1 OR n.user_id IS NULL
     ORDER BY n.created_at DESC LIMIT $2`,
    [userId, limit]
  );
}

async function all(userId, limit = 100) {
  return getLatest(userId, limit);
}

async function markAsRead(id, userId) {
  const n = await db.get('SELECT * FROM notifications WHERE id = $1', [id]);
  if (!n) return false;
  if (n.user_id === null) {
    await db.run(
      'INSERT INTO notification_reads (notification_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, userId]
    );
    return true;
  }
  if (parseInt(n.user_id, 10) !== parseInt(userId, 10)) return false;
  await db.run('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [id, userId]);
  return true;
}

async function markAllAsRead(userId) {
  await db.tx(async t => {
    await t.run('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [userId]);
    await t.run(
      `INSERT INTO notification_reads (notification_id, user_id)
       SELECT id, $1 FROM notifications WHERE user_id IS NULL
       ON CONFLICT DO NOTHING`,
      [userId]
    );
  });
  return true;
}

module.exports = { send, sendToAdmins, getUnreadCount, getLatest, all, markAsRead, markAllAsRead };
