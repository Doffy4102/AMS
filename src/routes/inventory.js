// Inventory + Catalog setup + License setup + Stock movements routes.
const express = require('express');
const inventoryService = require('../services/inventoryService');
const workflowService = require('../services/inventoryWorkflowService');
const catalogService = require('../services/catalogService');
const departmentService = require('../services/departmentService');
const licenseSetupService = require('../services/licenseSetupService');
const stockService = require('../services/stockMovementService');
const Paginator = require('../core/paginator');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { hamsUrl, sanitizeBody, intOr, csvRow, timestampSlug } = require('../core/helpers');

const router = express.Router();

function idsFrom(body) {
  let ids = body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  return ids.map(Number).filter(Boolean);
}

// ─── Inventory Setup (catalog) ───
router.get('/inventory-setup', authRequired, perm('inventory.view'), mod('inventory'), async (req, res, next) => {
  try {
    res.renderPage('assets/catalog', { cards: await catalogService.overviewCards() });
  } catch (err) { next(err); }
});

// Departments (registered before /inventory-setup/:type)
router.get('/inventory-setup/departments', authRequired, perm('personnel.view'), mod('personnel'), async (req, res, next) => {
  try {
    const page = intOr(req.query.page, 1);
    const filters = { search: String(req.query.search || '') };
    const total = await departmentService.count(filters);
    const paginator = new Paginator(total, 15, page);
    res.renderPage('users/departments', {
      departments: await departmentService.list(paginator.currentPage, 15, filters),
      paginator, total, filters,
      metadata: await departmentService.getMetadata()
    });
  } catch (err) { next(err); }
});

router.post('/inventory-setup/departments', authRequired, csrfProtect, perm('personnel.create'), mod('personnel'), async (req, res, next) => {
  try {
    try {
      await departmentService.create(sanitizeBody(req.body));
      req.flash('success', 'Department created successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory-setup/departments'));
  } catch (err) { next(err); }
});

router.post('/inventory-setup/departments/bulk-delete', authRequired, csrfProtect, perm('personnel.delete'), mod('personnel'), async (req, res, next) => {
  try {
    const ids = idsFrom(req.body);
    let successCount = 0;
    const errors = [];
    for (const id of ids) {
      try { await departmentService.remove(id); successCount += 1; }
      catch (err) { errors.push(err.message); }
    }
    if (successCount > 0) req.flash('success', `Successfully deleted ${successCount} department(s).`);
    if (errors.length) req.flash('error', 'Some departments could not be deleted: ' + [...new Set(errors)].join(', '));
    res.redirect(hamsUrl('/inventory-setup/departments'));
  } catch (err) { next(err); }
});

router.post('/inventory-setup/departments/:id/update', authRequired, csrfProtect, perm('personnel.edit'), mod('personnel'), async (req, res, next) => {
  try {
    try {
      await departmentService.update(intOr(req.params.id), sanitizeBody(req.body));
      req.flash('success', 'Department updated successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory-setup/departments'));
  } catch (err) { next(err); }
});

router.post('/inventory-setup/departments/:id/delete', authRequired, csrfProtect, perm('personnel.delete'), mod('personnel'), async (req, res, next) => {
  try {
    try {
      await departmentService.remove(intOr(req.params.id));
      req.flash('success', 'Department deleted successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory-setup/departments'));
  } catch (err) { next(err); }
});

router.get('/inventory-setup/:type', authRequired, perm('inventory.view'), mod('inventory'), async (req, res, next) => {
  try {
    const filters = { search: req.query.search || null };
    const page = await catalogService.page(req.params.type, intOr(req.query.page, 1), 15, filters);
    res.renderPage('assets/catalog-page', { page, filters });
  } catch (err) {
    if (err.status) return res.renderPage('_error', { message: err.message, statusCode: err.status });
    next(err);
  }
});

router.post('/inventory-setup/:type/bulk-delete', authRequired, csrfProtect, perm('inventory.delete'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      const count = await catalogService.bulkDelete(req.params.type, idsFrom(req.body), user);
      req.flash('success', `${count} record(s) deleted.`);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory-setup/' + req.params.type));
  } catch (err) { next(err); }
});

router.post('/inventory-setup/:type', authRequired, csrfProtect, perm('inventory.create'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await catalogService.create(req.params.type, sanitizeBody(req.body), user);
      req.flash('success', 'Inventory setup item created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory-setup/' + req.params.type));
  } catch (err) { next(err); }
});

router.post('/inventory-setup/:type/:id/update', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await catalogService.update(req.params.type, intOr(req.params.id), sanitizeBody(req.body), user);
      req.flash('success', 'Inventory setup item updated.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory-setup/' + req.params.type));
  } catch (err) { next(err); }
});

router.post('/inventory-setup/:type/:id/delete', authRequired, csrfProtect, perm('inventory.delete'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await catalogService.remove(req.params.type, intOr(req.params.id), user);
      req.flash('success', 'Record deleted.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory-setup/' + req.params.type));
  } catch (err) { next(err); }
});

// ─── License Setup ───
router.get('/licenses/setup', authRequired, perm('licenses.manage_setup'), mod('licenses'), async (req, res, next) => {
  try {
    res.renderPage('inventory/license-setup', { page: await licenseSetupService.page() });
  } catch (err) { next(err); }
});

router.post('/licenses/setup/:type', authRequired, csrfProtect, perm('licenses.manage_setup'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await licenseSetupService.create(req.params.type, sanitizeBody(req.body), user);
      req.flash('success', 'License setup record created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/licenses/setup'));
  } catch (err) { next(err); }
});

router.post('/licenses/setup/:type/:id/update', authRequired, csrfProtect, perm('licenses.manage_setup'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await licenseSetupService.update(req.params.type, intOr(req.params.id), sanitizeBody(req.body), user);
      req.flash('success', 'License setup record updated.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/licenses/setup'));
  } catch (err) { next(err); }
});

router.post('/licenses/setup/:type/:id/delete', authRequired, csrfProtect, perm('licenses.manage_setup'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await licenseSetupService.remove(req.params.type, intOr(req.params.id), user);
      req.flash('success', 'License setup record deleted.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/licenses/setup'));
  } catch (err) { next(err); }
});

// ─── Inventory pages ───
function invPage(type) {
  return async (req, res, next) => {
    try {
      const user = await currentUser(req);
      const filters = { search: req.query.search || req.body?.search || null };
      const page = await inventoryService.page(type, intOr(req.query.page, 1), 15, filters, user);
      res.renderPage('inventory/page', { page, filters });
    } catch (err) {
      if (err.status) return res.renderPage('_error', { message: err.message, statusCode: err.status });
      next(err);
    }
  };
}

router.get('/inventory/licenses', authRequired, perm('licenses.view'), mod('licenses'), invPage('licenses'));
router.get('/inventory', authRequired, perm('inventory.view'), mod('inventory'),
  (req, res) => res.redirect(hamsUrl('/inventory/consumables')));

// license write routes before generic :type
function invStore(typeResolver, permName, modName) {
  return [authRequired, csrfProtect, perm(permName), mod(modName), async (req, res, next) => {
    try {
      const user = await currentUser(req);
      const type = typeResolver(req);
      try {
        await inventoryService.create(type, sanitizeBody(req.body), user);
        req.flash('success', 'Inventory item created.');
      } catch (err) { req.flash('error', err.message); }
      res.redirect(hamsUrl('/inventory/' + type));
    } catch (err) { next(err); }
  }];
}

router.post('/inventory/licenses', ...invStore(() => 'licenses', 'licenses.create', 'licenses'));
router.post('/inventory/licenses/bulk-delete', authRequired, csrfProtect, perm('licenses.delete'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      const count = await inventoryService.bulkDelete('licenses', idsFrom(req.body), user);
      req.flash('success', `${count} item(s) deleted.`);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/licenses'));
  } catch (err) { next(err); }
});
router.post('/inventory/licenses/assignments/:assignmentId/return', authRequired, csrfProtect, perm('licenses.edit'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await workflowService.returnAssignment('licenses', intOr(req.params.assignmentId), user ? user.id : null);
      req.flash('success', 'Return/revoke recorded.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(req.get('referer') || hamsUrl('/inventory/licenses'));
  } catch (err) { next(err); }
});
router.get('/inventory/licenses/:id/history', authRequired, perm('licenses.view'), mod('licenses'), async (req, res, next) => {
  try {
    const id = intOr(req.params.id);
    res.renderPage('inventory/history', {
      type: 'licenses', id,
      item: await workflowService.getItem('licenses', id),
      history: await workflowService.history('licenses', id)
    });
  } catch (err) { next(err); }
});
router.post('/inventory/licenses/:id/update', authRequired, csrfProtect, perm('licenses.edit'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await inventoryService.update('licenses', intOr(req.params.id), sanitizeBody(req.body), user);
      req.flash('success', 'Inventory item updated.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/licenses'));
  } catch (err) { next(err); }
});
router.post('/inventory/licenses/:id/delete', authRequired, csrfProtect, perm('licenses.delete'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await inventoryService.remove('licenses', intOr(req.params.id), user);
      req.flash('success', 'Item deleted.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/licenses'));
  } catch (err) { next(err); }
});
router.post('/inventory/licenses/:id/assign', authRequired, csrfProtect, perm('licenses.edit'), mod('licenses'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await workflowService.assign('licenses', intOr(req.params.id), sanitizeBody(req.body), user ? user.id : null);
      req.flash('success', 'Assignment recorded.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/licenses'));
  } catch (err) { next(err); }
});

router.get('/inventory/:type', authRequired, perm('inventory.view'), mod('inventory'),
  (req, res, next) => invPage(req.params.type)(req, res, next));

router.post('/inventory/:type/bulk-delete', authRequired, csrfProtect, perm('inventory.delete'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      const count = await inventoryService.bulkDelete(req.params.type, idsFrom(req.body), user);
      req.flash('success', `${count} item(s) deleted.`);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/' + req.params.type));
  } catch (err) { next(err); }
});

router.post('/inventory/:type/assignments/:assignmentId/return', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await workflowService.returnAssignment(req.params.type, intOr(req.params.assignmentId), user ? user.id : null);
      req.flash('success', 'Return/revoke recorded.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(req.get('referer') || hamsUrl('/inventory/' + req.params.type));
  } catch (err) { next(err); }
});

router.post('/inventory/:type', authRequired, csrfProtect, perm('inventory.create'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await inventoryService.create(req.params.type, sanitizeBody(req.body), user);
      req.flash('success', 'Inventory item created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/' + req.params.type));
  } catch (err) { next(err); }
});

router.get('/inventory/:type/:id/history', authRequired, perm('inventory.view'), mod('inventory'), async (req, res, next) => {
  try {
    const id = intOr(req.params.id);
    res.renderPage('inventory/history', {
      type: req.params.type, id,
      item: await workflowService.getItem(req.params.type, id),
      history: await workflowService.history(req.params.type, id)
    });
  } catch (err) { next(err); }
});

router.post('/inventory/:type/:id/update', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await inventoryService.update(req.params.type, intOr(req.params.id), sanitizeBody(req.body), user);
      req.flash('success', 'Inventory item updated.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/' + req.params.type));
  } catch (err) { next(err); }
});

router.post('/inventory/:type/:id/delete', authRequired, csrfProtect, perm('inventory.delete'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await inventoryService.remove(req.params.type, intOr(req.params.id), user);
      req.flash('success', 'Item deleted.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/' + req.params.type));
  } catch (err) { next(err); }
});

router.post('/inventory/:type/:id/assign', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await workflowService.assign(req.params.type, intOr(req.params.id), sanitizeBody(req.body), user ? user.id : null);
      req.flash('success', 'Assignment recorded.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/inventory/' + req.params.type));
  } catch (err) { next(err); }
});

// ─── Stock Movements ───
router.get('/stock-movements', authRequired, perm('inventory.view'), mod('inventory'), async (req, res, next) => {
  try {
    const filters = {
      module: req.query.module || '', item_id: req.query.item_id || '', search: req.query.search || ''
    };
    res.renderPage('stock/index', { page: await stockService.pageData(filters) });
  } catch (err) { next(err); }
});

router.post('/stock-movements/filter', authRequired, csrfProtect, perm('inventory.view'), mod('inventory'), async (req, res, next) => {
  try {
    res.renderPage('stock/index', { page: await stockService.pageData(sanitizeBody(req.body)) });
  } catch (err) { next(err); }
});

router.post('/stock-movements/bulk-rollback', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const ids = idsFrom(req.body);
    if (!ids.length) {
      req.flash('error', 'No movements selected.');
      return res.redirect(hamsUrl('/stock-movements'));
    }
    try {
      await stockService.bulkRollback(ids, user ? user.id : null);
      req.flash('success', 'Selected stock movements rolled back successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/stock-movements'));
  } catch (err) { next(err); }
});

router.post('/stock-movements/bulk-export', authRequired, csrfProtect, perm('inventory.view'), mod('inventory'), async (req, res, next) => {
  try {
    const ids = idsFrom(req.body);
    if (!ids.length) {
      req.flash('error', 'No items selected for export.');
      return res.redirect(hamsUrl('/stock-movements'));
    }
    const rows = await stockService.exportRows(ids);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=hams_stock_movements_export_${timestampSlug()}.csv`);
    const lines = [csvRow(['ID', 'Item Name', 'Module', 'Movement Type', 'Direction', 'Quantity', 'Reason', 'Reference', 'Notes', 'Created By', 'Created At'])];
    for (const r of rows) {
      lines.push(csvRow([
        r.id, r.item_name, r.module_label, r.movement_type || '', String(r.direction).toUpperCase(),
        r.quantity, r.reason || 'Not set', r.reference || 'Not set', r.notes || '',
        r.created_by_name || 'System', r.created_at
      ]));
    }
    res.send(lines.join('\n'));
  } catch (err) { next(err); }
});

router.post('/stock-movements', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await stockService.create(sanitizeBody(req.body), user ? user.id : null);
      req.flash('success', 'Stock movement recorded.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/stock-movements'));
  } catch (err) { next(err); }
});

router.post('/stock-movements/:id/update', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await stockService.update(intOr(req.params.id), sanitizeBody(req.body), user ? user.id : null);
      req.flash('success', 'Stock movement updated successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/stock-movements'));
  } catch (err) { next(err); }
});

router.post('/stock-movements/:id/delete', authRequired, csrfProtect, perm('inventory.edit'), mod('inventory'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await stockService.rollback(intOr(req.params.id), user ? user.id : null);
      req.flash('success', 'Stock movement rolled back successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/stock-movements'));
  } catch (err) { next(err); }
});

module.exports = router;
