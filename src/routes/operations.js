// Portal, Requests, Operations (alerts/audit/maintenance), Archive, Notifications, Barcode scanner.
const express = require('express');
const db = require('../core/db');
const assetService = require('../services/assetService');
const requestService = require('../services/requestService');
const operationsService = require('../services/operationsService');
const archiveService = require('../services/archiveService');
const notificationService = require('../services/notificationService');
const authz = require('../services/authorizationService');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { hamsUrl, sanitizeBody, intOr } = require('../core/helpers');

const router = express.Router();

// ─── Employee Portal ───
async function portalDashboard(req, res, next) {
  try {
    const userId = req.session.user_id;
    const [assets, requests, accessories, licenses, components] = await Promise.all([
      assetService.getAssignedToUser(userId),
      requestService.mine(userId),
      assetService.getAssignedAccessories(userId),
      assetService.getAssignedLicenses(userId),
      assetService.getAssignedComponents(userId)
    ]);
    res.renderPage('portal/dashboard', {
      assets: assets.slice(0, 5),
      requests: requests.slice(0, 5),
      counts: {
        assets: assets.length, accessories: accessories.length,
        licenses: licenses.length, components: components.length
      }
    });
  } catch (err) { next(err); }
}
router.get('/portal', authRequired, portalDashboard);
router.get('/portal/dashboard', authRequired, portalDashboard);

router.get('/portal/my-assets', authRequired, async (req, res, next) => {
  try {
    const userId = req.session.user_id;
    res.renderPage('portal/my-assets', {
      assets: await assetService.getAssignedToUser(userId),
      accessories: await assetService.getAssignedAccessories(userId),
      licenses: await assetService.getAssignedLicenses(userId),
      components: await assetService.getAssignedComponents(userId)
    });
  } catch (err) { next(err); }
});

router.get('/portal/requests', authRequired, async (req, res, next) => {
  try {
    res.renderPage('portal/requests', {
      requests: await requestService.mine(req.session.user_id),
      references: await requestService.references()
    });
  } catch (err) { next(err); }
});

router.post('/portal/requests', authRequired, csrfProtect, async (req, res, next) => {
  try {
    try {
      await requestService.create(sanitizeBody(req.body), req.session.user_id);
      req.flash('success', 'Request submitted successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/portal/requests'));
  } catch (err) { next(err); }
});

// ─── Barcode scanner ───
router.get('/portal/scan', authRequired, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('portal/barcode-scanner', { references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.post('/api/barcode/lookup', authRequired, async (req, res, next) => {
  try {
    const code = String((req.body && req.body.code) || '').trim();
    if (!code) return res.json({ ok: false, message: 'No barcode or asset tag provided' });
    let asset = null;
    const tokenMatch = code.match(/\/labels\/assets\/([a-zA-Z0-9]+)/);
    if (tokenMatch) asset = await assetService.findByLabelToken(tokenMatch[1]);
    if (!asset) asset = await assetService.findByBarcodeOrTag(code);
    if (!asset) return res.json({ ok: false, message: `Asset not found for: ${code}` });
    let cf = asset.custom_fields_data;
    if (typeof cf === 'string') { try { cf = JSON.parse(cf); } catch (_) { cf = {}; } }
    res.json({
      ok: true,
      asset: {
        id: asset.id, name: asset.name, asset_tag: asset.asset_tag,
        serial_number: asset.serial_number || 'N/A',
        model_number: asset.model_number || 'N/A',
        category: asset.category_name || asset.category || 'Uncategorized',
        status: asset.status_label_name || asset.status || 'Unknown',
        status_color: asset.status_label_color || '',
        location: asset.location_name || 'Unassigned',
        sub_location: asset.sub_location_name || '',
        assigned_to: asset.assigned_to_name || null,
        purchase_date: asset.purchase_date, warranty_expiry: asset.warranty_expiry,
        purchase_cost: asset.purchase_cost,
        notes: asset.notes || '',
        custom_fields: cf || {}
      }
    });
  } catch (err) { next(err); }
});

// ─── Requests ───
router.get('/my-requests', authRequired, perm('requests.view'), mod('requests'), async (req, res, next) => {
  try {
    res.renderPage('requests/mine', {
      requests: await requestService.mine(req.session.user_id),
      references: await requestService.references()
    });
  } catch (err) { next(err); }
});

router.post('/my-requests', authRequired, csrfProtect, perm('requests.create'), mod('requests'), async (req, res, next) => {
  try {
    try {
      await requestService.create(sanitizeBody(req.body), req.session.user_id);
      req.flash('success', 'Request submitted.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/my-requests'));
  } catch (err) { next(err); }
});

router.get('/requests', authRequired, perm('requests.approve'), mod('requests'), async (req, res, next) => {
  try {
    res.renderPage('requests/admin', { requests: await requestService.all() });
  } catch (err) { next(err); }
});

router.post('/requests/:id/review', authRequired, csrfProtect, perm('requests.approve'), mod('requests'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await requestService.review(intOr(req.params.id), req.body.status || '', user.id, req.body.review_notes || '');
      req.flash('success', 'Request reviewed.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/requests'));
  } catch (err) { next(err); }
});

// ─── Operations ───
router.get('/alerts', authRequired, perm('inventory.view'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    await authz.requirePermission('audit.view', user); // internal require in original
    res.renderPage('operations/alerts', { sections: await operationsService.alerts(), active_tab: 'alerts' });
  } catch (err) { next(err); }
});

router.get('/audit', authRequired, perm('audit.view'), mod('audit'), async (req, res, next) => {
  try {
    res.renderPage('operations/audit', { logs: await operationsService.auditLogs(100), active_tab: 'audit' });
  } catch (err) { next(err); }
});

router.get('/maintenance', authRequired, perm('maintenance.view'), mod('maintenance'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    await authz.requirePermission('maintenance.manage', user);
    const filters = {
      search: String(req.query.search || ''),
      status: String(req.query.status || ''),
      type: String(req.query.type || '')
    };
    res.renderPage('operations/maintenance', {
      records: await operationsService.maintenanceRecords(filters),
      references: await operationsService.maintenanceReferences(),
      filters
    });
  } catch (err) { next(err); }
});

router.post('/maintenance', authRequired, csrfProtect, perm('maintenance.create'), mod('maintenance'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    await authz.requirePermission('maintenance.manage', user);
    try {
      await operationsService.createMaintenance(sanitizeBody(req.body), user.id);
      req.flash('success', 'Maintenance record created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/maintenance'));
  } catch (err) { next(err); }
});

router.post('/maintenance/:id/update', authRequired, csrfProtect, perm('maintenance.create'), mod('maintenance'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    await authz.requirePermission('maintenance.manage', user);
    try {
      await operationsService.updateMaintenance(intOr(req.params.id), sanitizeBody(req.body), user.id);
      req.flash('success', 'Maintenance record updated.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/maintenance'));
  } catch (err) { next(err); }
});

// ─── Archive ───
router.get('/archive', authRequired, perm('settings.manage'), async (req, res, next) => {
  try {
    res.renderPage('archive/index', {
      groups: await archiveService.groups(),
      retention_days: await archiveService.getRetentionDays(),
      active_tab: 'archive'
    });
  } catch (err) { next(err); }
});

router.post('/archive/settings', authRequired, csrfProtect, perm('settings.manage'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await archiveService.updateRetentionDays(req.body.retention_days || 7, user.id);
      req.flash('success', 'Archive retention policy updated successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/archive'));
  } catch (err) { next(err); }
});

router.post('/archive/:type/:id/restore', authRequired, csrfProtect, perm('settings.manage'), async (req, res, next) => {
  try {
    try {
      await archiveService.restore(req.params.type, intOr(req.params.id));
      req.flash('success', 'Record restored.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/archive'));
  } catch (err) { next(err); }
});

// ─── Notifications ───
router.get('/notifications', authRequired, perm('requests.view'), mod('requests'), async (req, res, next) => {
  try {
    res.renderPage('notifications/index', {
      notifications: await notificationService.all(req.session.user_id, 150)
    });
  } catch (err) { next(err); }
});

router.post('/notifications/read-all', authRequired, csrfProtect, async (req, res, next) => {
  try {
    await notificationService.markAllAsRead(req.session.user_id);
    req.flash('success', 'Notifications marked as read.');
    res.redirect(hamsUrl('/notifications'));
  } catch (err) { next(err); }
});

router.post('/notifications/:id/read', authRequired, csrfProtect, async (req, res, next) => {
  try {
    await notificationService.markAsRead(intOr(req.params.id), req.session.user_id);
    res.redirect(hamsUrl('/notifications'));
  } catch (err) { next(err); }
});

module.exports = router;
