// Asset routes (port of AssetController + Dashboard + scan/label APIs + Procurement + Timeline + Catalog API).
const express = require('express');
const multer = require('multer');
const db = require('../core/db');
const assetService = require('../services/assetService');
const customFieldService = require('../services/customFieldService');
const platformService = require('../services/platformService');
const procurementService = require('../services/procurementService');
const timelineService = require('../services/timelineService');
const catalogService = require('../services/catalogService');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { hamsUrl, sanitizeBody, intOr } = require('../core/helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Dashboard ───
async function dashboardPage(req, res, next) {
  try {
    res.renderPage('home', { dashboard: await platformService.dashboard() });
  } catch (err) { next(err); }
}
router.get('/', authRequired, perm('dashboard.view'), dashboardPage);
router.get('/dashboard', authRequired, perm('dashboard.view'), dashboardPage);

// ─── Assets ───
router.get('/assets', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const page = intOr(req.query.page, 1);
    const search = String(req.query.search || '');
    const filters = {
      search,
      category_id: req.query.category_id || null,
      status_label_id: req.query.status_label_id || null,
      location_id: req.query.location_id || null,
      manufacturer_id: req.query.manufacturer_id || null
    };
    const result = await assetService.page(page, 15, filters, user);
    const references = await assetService.getReferenceData(user);
    let baseUrl = hamsUrl('/assets');
    if (search) baseUrl += '?search=' + encodeURIComponent(search);
    res.renderPage('assets/index', {
      assets: result.items, paginator: result.paginator, total: result.total,
      filters, references, baseUrl
    });
  } catch (err) { next(err); }
});

router.get('/assets/create', authRequired, perm('assets.create'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('assets/create', {
      references: await assetService.getReferenceData(user),
      asset_tag: await assetService.nextAssetTag()
    });
  } catch (err) { next(err); }
});

router.get('/assets/labels', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    let rawIds = req.query.ids || [];
    if (!Array.isArray(rawIds)) rawIds = String(rawIds).split(',');
    res.renderPage('assets/labels', { assets: await assetService.getLabelAssets(rawIds, user) });
  } catch (err) { next(err); }
});

router.get('/assets/scan', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('assets/scan', { references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.get('/labels/assets/:token', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const asset = await assetService.findByLabelToken(req.params.token);
    if (!asset) return res.renderPage('_error', { message: 'Asset label not found', statusCode: 404 });
    res.redirect(hamsUrl('/assets/' + asset.id));
  } catch (err) { next(err); }
});

router.get('/api/scan/:token', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const asset = await assetService.findByLabelToken(req.params.token);
    if (!asset) return res.status(404).json({ ok: false, message: 'Asset not found' });
    const status = String(asset.status_label_name || asset.status || '').toLowerCase();
    const isAvailable = ['available', 'ready to deploy', 'ready', 'in stock'].includes(status);
    const isAssigned = ['assigned', 'deployed', 'in use'].includes(status);
    res.json({
      ok: true,
      asset: {
        id: asset.id, name: asset.name, asset_tag: asset.asset_tag,
        serial: asset.serial_number,
        status: asset.status_label_name || asset.status,
        category: asset.category_name || asset.category
      },
      actions: { can_checkout: isAvailable, can_checkin: isAssigned },
      links: {
        view: hamsUrl('/assets/' + asset.id),
        checkout: hamsUrl('/assets/' + asset.id + '/checkout'),
        checkin: hamsUrl('/assets/' + asset.id + '/checkin')
      }
    });
  } catch (err) { next(err); }
});

router.post('/assets', authRequired, csrfProtect, perm('assets.create'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const data = sanitizeBody(req.body);
    try {
      if (await assetService.registerAsset(data, user)) {
        req.flash('success', 'Asset registered in enterprise ledger');
        return res.redirect(hamsUrl('/assets'));
      }
      req.flash('error', 'Registration failed');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/create'));
  } catch (err) { next(err); }
});

router.get('/api/categories/:id/fields', authRequired, mod('assets'), async (req, res, next) => {
  try {
    res.json(await customFieldService.getFieldsByCategory(intOr(req.params.id)));
  } catch (err) { next(err); }
});

router.get('/api/locations/:id/sub-locations', authRequired, mod('assets'), async (req, res, next) => {
  try {
    const rows = await db.query(
      'SELECT id, name, code, floor, room FROM sub_locations WHERE location_id = $1 AND deleted_at IS NULL ORDER BY name ASC',
      [intOr(req.params.id)]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/assets/bulk-delete', authRequired, csrfProtect, perm('assets.delete'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(Number).filter(Boolean);
    if (!ids.length) {
      req.flash('error', 'No assets selected.');
      return res.redirect(hamsUrl('/assets'));
    }
    const deleted = await assetService.bulkDeleteAssets(ids, user);
    req.flash('success', `${deleted} asset(s) deleted.`);
    res.redirect(hamsUrl('/assets'));
  } catch (err) { next(err); }
});

router.post('/assets/bulk-update', authRequired, csrfProtect, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(Number).filter(Boolean);
    if (!ids.length) {
      req.flash('error', 'No assets selected.');
      return res.redirect(hamsUrl('/assets'));
    }
    const updateData = {};
    if (req.body.status_label_id) updateData.status_label_id = req.body.status_label_id;
    if (req.body.location_id) updateData.location_id = req.body.location_id;
    if (!Object.keys(updateData).length) {
      req.flash('error', 'No update fields provided.');
      return res.redirect(hamsUrl('/assets'));
    }
    try {
      const updated = await assetService.bulkUpdateAssets(ids, updateData, user);
      req.flash('success', `${updated} asset(s) updated successfully.`);
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets'));
  } catch (err) { next(err); }
});

router.get('/assets/:id', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const asset = await assetService.getAsset(intOr(req.params.id), user);
    if (!asset) return res.renderPage('_error', { message: 'Asset not found', statusCode: 404 });
    res.renderPage('assets/show', {
      asset,
      references: await assetService.getReferenceData(user),
      assignments: await assetService.assignmentHistory(asset.id),
      stock_history: await assetService.stockHistory(asset.id),
      custom_fields: await customFieldService.getFieldsByCategory(asset.category_id || 0),
      book_value: assetService.calculateDepreciation(asset)
    });
  } catch (err) { next(err); }
});

router.get('/assets/:id/edit', authRequired, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const asset = await assetService.getAsset(intOr(req.params.id), user);
    if (!asset) return res.renderPage('_error', { message: 'Asset not found', statusCode: 404 });
    res.renderPage('assets/edit', { asset, references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.post('/assets/:id/update', authRequired, csrfProtect, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      if (await assetService.updateAsset(id, sanitizeBody(req.body), user)) {
        req.flash('success', 'Asset updated successfully');
        return res.redirect(hamsUrl('/assets/' + id));
      }
      req.flash('error', 'Asset update failed');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/' + id + '/edit'));
  } catch (err) { next(err); }
});

router.post('/assets/:id/delete', authRequired, csrfProtect, perm('assets.delete'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (await assetService.deleteAsset(intOr(req.params.id), user)) {
      req.flash('success', 'Asset deleted successfully');
    } else {
      req.flash('error', 'Asset delete failed');
    }
    res.redirect(hamsUrl('/assets'));
  } catch (err) { next(err); }
});

router.post('/assets/:id/checkout', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      await assetService.checkoutAsset(id, sanitizeBody(req.body), user);
      req.flash('success', 'Asset checked out successfully');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/' + id));
  } catch (err) { next(err); }
});

router.post('/assets/:id/checkin', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      await assetService.checkinAsset(id, sanitizeBody(req.body), user);
      req.flash('success', 'Asset checked in successfully');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/' + id));
  } catch (err) { next(err); }
});

// ─── Catalog API (inline creation) ───
router.get('/api/catalog/:type/search', authRequired, async (req, res) => {
  try {
    const results = await catalogService.search(req.params.type, String(req.query.q || '').trim());
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

router.post('/api/catalog/:type', authRequired, csrfProtect, async (req, res) => {
  try {
    const user = await currentUser(req);
    const data = sanitizeBody(req.body);
    const id = await catalogService.create(req.params.type, data, user);
    res.json({ ok: true, record: await catalogService.getCreatedRecord(req.params.type, id, data) });
  } catch (err) {
    res.status(422).json({ ok: false, message: err.message });
  }
});

// ─── Procurement ───
router.get('/procurement', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    res.renderPage('procurement/index', { records: await procurementService.getAllRecords() });
  } catch (err) { next(err); }
});

router.get('/procurement/create', authRequired, perm('assets.create'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('procurement/create', { references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.post('/procurement', authRequired,
  upload.fields([{ name: 'invoice', maxCount: 1 }, { name: 'po', maxCount: 1 }]), csrfProtect,
  perm('assets.create'), mod('assets'), async (req, res, next) => {
    try {
      const user = await currentUser(req);
      try {
        const id = await procurementService.createRecord(sanitizeBody(req.body), req.files, user);
        if (id) {
          req.flash('success', 'Procurement record created successfully');
          return res.redirect(hamsUrl('/procurement'));
        }
      } catch (err) {
        req.flash('error', err.message);
      }
      res.redirect(hamsUrl('/procurement/create'));
    } catch (err) { next(err); }
  });

router.get('/procurement/:id', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const record = await procurementService.getRecord(intOr(req.params.id));
    if (!record) return res.renderPage('_error', { message: 'Record not found', statusCode: 404 });
    res.renderPage('procurement/show', { record, assets: await procurementService.getLinkedAssets(record.id) });
  } catch (err) { next(err); }
});

router.get('/procurement/:id/edit', authRequired, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const record = await procurementService.getRecord(intOr(req.params.id));
    if (!record) return res.renderPage('_error', { message: 'Record not found', statusCode: 404 });
    res.renderPage('procurement/edit', { record, references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.post('/procurement/:id/update', authRequired,
  upload.fields([{ name: 'invoice', maxCount: 1 }, { name: 'po', maxCount: 1 }]), csrfProtect,
  perm('assets.edit'), mod('assets'), async (req, res, next) => {
    try {
      const user = await currentUser(req);
      const id = intOr(req.params.id);
      try {
        if (await procurementService.updateRecord(id, sanitizeBody(req.body), req.files, user)) {
          req.flash('success', 'Procurement record updated successfully');
          return res.redirect(hamsUrl('/procurement/' + id));
        }
      } catch (err) {
        req.flash('error', err.message);
      }
      res.redirect(hamsUrl('/procurement/' + id + '/edit'));
    } catch (err) { next(err); }
  });

// ─── Internal APIs + Timeline ───
router.get('/api/dashboard', authRequired, perm('dashboard.view'), async (req, res, next) => {
  try { res.json(await platformService.dashboard()); } catch (err) { next(err); }
});

router.get('/api/assets', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try { res.json(await assetService.all()); } catch (err) { next(err); }
});

router.get('/timeline/:module/:id', authRequired, perm('assets.view'), async (req, res, next) => {
  try {
    res.renderPage('timeline/show', {
      module: req.params.module,
      id: req.params.id,
      events: await timelineService.get(req.params.module, intOr(req.params.id))
    });
  } catch (err) { next(err); }
});

module.exports = router;
