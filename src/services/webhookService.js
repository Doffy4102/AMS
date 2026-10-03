// Port of WebhookService: outbound integration webhooks with HMAC signature.
const crypto = require('crypto');
const db = require('../core/db');

async function dispatch(event, payload) {
  const hooks = await db.query('SELECT * FROM webhooks WHERE is_active = TRUE AND deleted_at IS NULL');
  for (const hook of hooks) {
    let events = [];
    try { events = JSON.parse(hook.events); } catch (_) {}
    if (Array.isArray(events) && (events.includes(event) || events.includes('*'))) {
      await send(hook, event, payload);
    }
  }
}

async function send(webhook, event, payload) {
  const body = JSON.stringify({ event, timestamp: Math.floor(Date.now() / 1000), payload });
  const headers = {
    'Content-Type': 'application/json',
    'X-HAMS-Event': event,
    'User-Agent': 'HAMS-Webhook-Agent/1.0'
  };
  if (webhook.secret) {
    headers['X-HAMS-Signature'] = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
  }
  let status = 'failed', responseCode = null, responseBody = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(webhook.url, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timer);
    responseCode = res.status;
    responseBody = (await res.text()).slice(0, 65000);
    status = res.ok ? 'success' : 'failed';
  } catch (err) {
    responseBody = String(err.message || err).slice(0, 65000);
  }
  try {
    await db.run(
      'INSERT INTO webhook_deliveries (webhook_id, event, payload, status, response_code, response_body) VALUES ($1,$2,$3,$4,$5,$6)',
      [webhook.id, event, body, status, responseCode, responseBody]);
  } catch (_) {}
  return status === 'success';
}

module.exports = { dispatch, send };
