// Asset Health Check (heartbeat) API — follows routes/api.js conventions:
// /api/v1 prefix, apiTokenAuth, { success, data } envelope, try/next(err).
const express = require('express');
const heartbeatService = require('../services/heartbeat/heartbeatService');
const { apiTokenAuth } = require('../middleware/apiToken');
const { intOr } = require('../core/helpers');

const router = express.Router();

// All current asset health statuses
router.get('/api/v1/health-status', apiTokenAuth, async (req, res, next) => {
  try {
    res.json({ success: true, data: await heartbeatService.listCurrentStatuses() });
  } catch (err) { next(err); }
});

// Single asset health status
router.get('/api/v1/health-status/:assetId', apiTokenAuth, async (req, res, next) => {
  try {
    const status = await heartbeatService.getStatus(intOr(req.params.assetId));
    if (!status) return res.status(404).json({ success: false, error: 'No health status for this asset' });
    res.json({ success: true, data: status });
  } catch (err) { next(err); }
});

// Heartbeat history for an asset
router.get('/api/v1/health-status/:assetId/heartbeats', apiTokenAuth, async (req, res, next) => {
  try {
    const rows = await heartbeatService.history(intOr(req.params.assetId), intOr(req.query.limit, 100));
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// Unresolved heartbeat alerts
router.get('/api/v1/heartbeat-alerts', apiTokenAuth, async (req, res, next) => {
  try {
    res.json({ success: true, data: await heartbeatService.unresolvedAlerts() });
  } catch (err) { next(err); }
});

// Resolve an alert
router.post('/api/v1/heartbeat-alerts/:id/resolve', apiTokenAuth, async (req, res, next) => {
  try {
    const ok = await heartbeatService.resolveAlert(intOr(req.params.id));
    if (!ok) return res.status(404).json({ success: false, error: 'Alert not found or already resolved' });
    res.json({ success: true, message: 'Alert resolved' });
  } catch (err) { next(err); }
});

// Configure monitoring for an asset
router.post('/api/v1/asset-monitors/:assetId', apiTokenAuth, async (req, res, next) => {
  try {
    const data = { ...req.query, ...req.body };
    if (!data.hostname && !data.ip_address) {
      return res.status(422).json({ success: false, error: 'hostname or ip_address is required' });
    }
    await heartbeatService.upsertMonitor(intOr(req.params.assetId), data);
    res.json({ success: true, message: 'Monitor configured' });
  } catch (err) { next(err); }
});

module.exports = router;
