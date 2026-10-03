// Endpoint-agent API: enrollment + heartbeat. These are called by the installed
// agent (not a browser), so they authenticate via headers, not the session:
//   - POST /api/v1/agent/enroll     X-Enrollment-Key: <key>   -> issues agent token
//   - POST /api/v1/agent/heartbeat  X-Agent-Token: <token>    -> records a beat
const express = require('express');
const agentService = require('../services/agentService');

const router = express.Router();

router.post('/api/v1/agent/enroll', async (req, res, next) => {
  try {
    const key = req.get('X-Enrollment-Key') || req.body.enrollment_key;
    if (!(await agentService.isValidEnrollmentKey(key))) {
      return res.status(401).json({ success: false, error: 'Invalid or inactive enrollment key.' });
    }
    const result = await agentService.enroll(req.body || {}, req.ip);
    res.status(201).json({
      success: true, agent_uid: result.agent_uid, token: result.token,
      asset_id: result.asset_id, heartbeat_interval_sec: 900
    });
  } catch (err) { next(err); }
});

router.post('/api/v1/agent/heartbeat', async (req, res, next) => {
  try {
    const token = req.get('X-Agent-Token') || req.body.token;
    const result = await agentService.heartbeat(token, req.body || {}, req.ip);
    if (!result.ok) return res.status(result.code || 400).json({ success: false, error: result.error });
    res.json({ success: true, agent_id: result.agent_id, heartbeat_interval_sec: result.interval_sec });
  } catch (err) { next(err); }
});

module.exports = router;
