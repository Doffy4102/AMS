// HAMS AI Assistant endpoint. The chat drawer in the header POSTs the user's
// question here; the service answers from live data only. Permission flags
// are computed per-request from the signed-in user so the assistant never
// reveals a data domain the user couldn't open in the sidebar.
const express = require('express');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const authz = require('../services/authorizationService');
const assistantService = require('../services/assistantService');
const { trimStr } = require('../core/helpers');

const router = express.Router();

router.post('/assistant/query', authRequired, csrfProtect, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const perms = {
      licenses: await authz.can('licenses.view', user),
      assets: await authz.can('assets.view', user),
      personnel: await authz.can('personnel.view', user),
      inventory: await authz.can('inventory.view', user)
    };
    const question = trimStr(req.body.question).slice(0, 500);
    const answer = await assistantService.answer(question, perms);
    res.json(answer);
  } catch (err) { next(err); }
});

module.exports = router;
