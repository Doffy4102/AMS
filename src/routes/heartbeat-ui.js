// Asset Health Check (heartbeat) UI routes — mirrors existing module routes style.
// Permission-gated to settings.manage (admin only, consistent with other monitoring).
const express = require('express');
const { authRequired } = require('../middleware/auth');
const { perm, mod } = require('../middleware/permission');
const db = require('../core/db');
const heartbeatService = require('../services/heartbeat/heartbeatService');
const { hamsUrl } = require('../core/helpers');

const router = express.Router();

// Asset detail: full heartbeat history + config
router.get('/heartbeat/:assetId', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.assetId, 10);
    // Load asset to verify it exists
    const asset = await db.get('SELECT id, name FROM assets WHERE id = $1 AND deleted_at IS NULL', [assetId]);
    if (!asset) return res.status(404).renderPage('_error', { message: 'Asset not found', statusCode: 404 });
    // Load status and history (may be empty if never monitored)
    const status = await heartbeatService.getStatus(assetId);
    const history = status ? await heartbeatService.history(assetId, 100) : [];
    // Load monitor config (may not exist yet)
    const monitor = await db.get(
      'SELECT * FROM asset_monitors WHERE asset_id = $1', [assetId]);
    res.renderPage('heartbeat/detail', { asset, status, history, monitor, assetId, hamsUrl });
  } catch (err) { next(err); }
});

// Configure monitoring for an asset (form + POST)
router.post('/heartbeat/:assetId/configure', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.assetId, 10);
    const { hostname, ip_address, check_method, port, health_url, monitoring_enabled } = req.body;
    await heartbeatService.upsertMonitor(assetId, {
      hostname, ip_address, check_method, port, health_url,
      monitoring_enabled: monitoring_enabled === 'on'
    });
    req.flash('success', 'Heartbeat monitor configured');
    res.redirect(hamsUrl(`/heartbeat/${assetId}`));
  } catch (err) { next(err); }
});

// Resolve an alert (AJAX or form)
router.post('/heartbeat/alerts/:alertId/resolve', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const alertId = parseInt(req.params.alertId, 10);
    const ok = await heartbeatService.resolveAlert(alertId);
    if (!ok) return res.status(404).json({ success: false, error: 'Alert not found' });
    req.flash('success', 'Alert resolved');
    if (req.accepts('json')) {
      res.json({ success: true, message: 'Alert resolved' });
    } else {
      res.redirect(req.get('referer') || hamsUrl('/'));
    }
  } catch (err) { next(err); }
});

module.exports = router;
