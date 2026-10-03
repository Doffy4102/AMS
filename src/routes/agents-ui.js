// Endpoint-agent management UI: agent roster, enrollment key, and the Windows /
// macOS agent downloads. Permission-gated to settings.manage (admin), matching
// the other Administration pages.
const express = require('express');
const { authRequired } = require('../middleware/auth');
const { perm, mod } = require('../middleware/permission');
const config = require('../config');
const agentService = require('../services/agentService');
const { windowsScript, macScript } = require('../services/agentScriptTemplates');
const { hamsUrl } = require('../core/helpers');

const router = express.Router();

// Roster + enrollment key + download links.
router.get('/agents', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const [agents, stats, key] = await Promise.all([
      agentService.listAgents(), agentService.agentStats(), agentService.getActiveKey()
    ]);
    res.renderPage('agents/index', {
      agents, stats, enrollmentKey: key.enrollment_key, serverUrl: config.appUrl, hamsUrl
    });
  } catch (err) { next(err); }
});

// Rotate the enrollment key (existing agents keep their tokens; only new
// enrollments need the new key).
router.post('/agents/keys/regenerate', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    await agentService.regenerateKey();
    req.flash('success', 'Enrollment key regenerated. Re-download the agent to enroll new machines.');
    res.redirect(hamsUrl('/agents'));
  } catch (err) { next(err); }
});

// Downloads: native scripts with the server URL + key baked in.
router.get('/agents/download/windows', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const key = await agentService.getActiveKey();
    const script = windowsScript(config.appUrl, key.enrollment_key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="hams-agent.ps1"');
    res.send(script);
  } catch (err) { next(err); }
});

router.get('/agents/download/mac', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const key = await agentService.getActiveKey();
    const script = macScript(config.appUrl, key.enrollment_key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="hams-agent.sh"');
    res.send(script);
  } catch (err) { next(err); }
});

module.exports = router;
