// New Joinees (Asset Management): onboarding asset allocation.
// The allocation agent drafts a laptop + headphones per designation from the
// joinee's own location; an engineer reviews/edits (location-scoped dropdowns)
// and approves. Guarded like the rest of Asset Management.
const express = require('express');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const newJoineeService = require('../services/newJoineeService');
const { hamsUrl, sanitizeBody, intOr } = require('../core/helpers');

const router = express.Router();

router.get('/new-joinees', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    // Allocation agent pass: draft location-matched onboarding assets for any
    // joinee without a current draft (never assigns — approval required).
    await newJoineeService.ensureDrafts();
    res.renderPage('new-joinees/index', {
      newJoinees: await newJoineeService.listJoinees(),
      allocationOptions: await newJoineeService.allocationOptions()
    });
  } catch (err) { next(err); }
});

// Engineer edits the agent's draft allocation (location-validated).
router.post('/new-joinees/:id/allocation', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await newJoineeService.updateDraft(intOr(req.params.id), sanitizeBody(req.body), actor);
      req.flash('success', 'Allocation draft updated.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/new-joinees'));
  } catch (err) { next(err); }
});

// Engineer approves — finalizes through the standard asset checkout +
// accessory assignment writers so Assets/Accessories tabs stay in sync.
router.post('/new-joinees/:id/allocate', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await newJoineeService.approveAllocation(intOr(req.params.id), actor);
      req.flash('success', 'Onboarding assets allocated — laptop and headphones are now reflected in Assets and Accessories.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/new-joinees'));
  } catch (err) { next(err); }
});

module.exports = router;
