// Reports, Import/Export, Export Center, Data Transfer, Report Schedules, Advanced.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const importExport = require('../services/importExportService');
const platformService = require('../services/platformService');
const dataTransfer = require('../services/dataTransferService');
const reportSchedules = require('../services/reportScheduleService');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { hamsUrl, sanitizeBody, intOr, csvRow, timestampSlug } = require('../core/helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const lines = [csvRow(headers), ...rows.map(r => csvRow(headers.map(h => r[h])))];
  res.send(lines.join('\n'));
}

// ─── Reports ───
router.get('/reports', authRequired, perm('reports.view'), mod('reports'), async (req, res, next) => {
  try {
    res.renderPage('platform/reports', {
      reports: await platformService.reports(),
      modules: await importExport.getModules()
    });
  } catch (err) { next(err); }
});

// ─── Report Schedules ───
router.get('/settings/report-schedules', authRequired, perm('reports.schedule'), mod('reports'), async (req, res, next) => {
  try {
    res.renderPage('settings/report-schedules', {
      schedules: await reportSchedules.schedules(),
      modules: await importExport.getModules(),
      active_tab: 'report_schedules'
    });
  } catch (err) { next(err); }
});

router.post('/settings/report-schedules', authRequired, csrfProtect, perm('reports.schedule'), mod('reports'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await reportSchedules.create(sanitizeBody(req.body), user.id);
      req.flash('success', 'Report schedule created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/report-schedules'));
  } catch (err) { next(err); }
});

router.post('/settings/report-schedules/run-due', authRequired, csrfProtect, perm('reports.schedule'), mod('reports'), async (req, res, next) => {
  try {
    const count = await reportSchedules.runDue();
    req.flash('success', `Scheduled reports executed: ${count}.`);
    res.redirect(hamsUrl('/settings/report-schedules'));
  } catch (err) { next(err); }
});

router.post('/settings/report-schedules/:id/toggle', authRequired, csrfProtect, perm('reports.schedule'), mod('reports'), async (req, res, next) => {
  try {
    await reportSchedules.toggle(intOr(req.params.id));
    req.flash('success', 'Report schedule updated.');
    res.redirect(hamsUrl('/settings/report-schedules'));
  } catch (err) { next(err); }
});

router.post('/settings/report-schedules/:id/delete', authRequired, csrfProtect, perm('reports.schedule'), mod('reports'), async (req, res, next) => {
  try {
    try {
      await reportSchedules.remove(intOr(req.params.id));
      req.flash('success', 'Report schedule deleted.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/report-schedules'));
  } catch (err) { next(err); }
});

router.get('/settings/report-schedules/:id/download', authRequired, perm('reports.view'), mod('reports'), async (req, res, next) => {
  try {
    const schedule = await reportSchedules.find(intOr(req.params.id));
    if (!schedule || !schedule.last_file_path || !fs.existsSync(schedule.last_file_path)) {
      req.flash('error', 'No generated report file is available for this schedule yet.');
      return res.redirect(hamsUrl('/settings/report-schedules'));
    }
    res.download(schedule.last_file_path, path.basename(schedule.last_file_path));
  } catch (err) { next(err); }
});

// ─── Import Center ───
router.get('/import', authRequired, perm('reports.create'), mod('reports'), async (req, res, next) => {
  try {
    res.renderPage('platform/import-hub', { modules: await importExport.getModules() });
  } catch (err) { next(err); }
});

router.post('/import/preview', authRequired, upload.single('csv_file'), csrfProtect, perm('reports.create'), mod('reports'), async (req, res, next) => {
  try {
    const module = req.body.module;
    const config = importExport.getModuleConfig(module);
    if (!config) {
      req.flash('error', 'Invalid module selected.');
      return res.redirect(hamsUrl('/import'));
    }
    try {
      const fileContent = req.file ? req.file.buffer.toString('utf8') : '';
      const rawText = (fileContent && fileContent.trim()) ? fileContent : (req.body.csv_paste || '');
      // Auto-detect the raw IT-ASMS hardware export and transform it into the
      // assets-module shape (handles its embedded-newline / shifted-column quirks).
      const asmsAdapter = require('../services/asmsAdapter');
      const firstLine = rawText.slice(0, 2000).split(/\r\n|\r|\n/)[0] || '';
      let parsed;
      let adapted = false;
      if (module === 'assets' && asmsAdapter.detect(firstLine)) {
        parsed = asmsAdapter.transform(rawText);
        adapted = true;
      } else {
        parsed = importExport.parseUpload(fileContent, req.body.csv_paste || '');
      }
      const validation = await importExport.validateRows(module, parsed.rows);
      req.session._import_preview = { module, valid_rows: validation.valid, errors: validation.errors };
      res.renderPage('platform/import-preview', {
        module, config: { ...config, columns: await importExport.getColumnsWithCustomFields(module) },
        headers: parsed.headers, total: parsed.total, validation,
        adapted, adaptedSkipped: parsed.skipped || 0
      });
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/import'));
    }
  } catch (err) { next(err); }
});

router.post('/import/execute', authRequired, csrfProtect, perm('reports.create'), mod('reports'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const preview = req.session._import_preview;
    if (!preview || !preview.valid_rows || !preview.valid_rows.length) {
      req.flash('error', 'No valid data to import. Please re-upload your file.');
      return res.redirect(hamsUrl('/import'));
    }
    delete req.session._import_preview;
    try {
      const result = await importExport.executeImport(preview.module, preview.valid_rows, user.id);
      let msg = `Import complete: ${result.imported} of ${result.total} rows imported.`;
      if (result.failed > 0) msg += ` ${result.failed} rows failed.`;
      req.flash('success', msg);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/import/history'));
  } catch (err) { next(err); }
});

router.get('/import/history', authRequired, perm('reports.view'), mod('reports'), async (req, res, next) => {
  try {
    res.renderPage('platform/import-history', { jobs: await importExport.importHistory() });
  } catch (err) { next(err); }
});

router.get('/import/template/:module', authRequired, perm('reports.create'), mod('reports'), async (req, res, next) => {
  try {
    try {
      const csv = await importExport.generateTemplate(req.params.module);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${req.params.module}-import-template.csv`);
      res.send(csv);
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/import'));
    }
  } catch (err) { next(err); }
});

// ─── Export Center ───
router.get('/export-center/:module', authRequired, perm('reports.view'), mod('reports'), async (req, res, next) => {
  try {
    const config = importExport.getModuleConfig(req.params.module);
    if (!config) return res.renderPage('_error', { message: 'Unknown module', statusCode: 404 });
    res.renderPage('platform/export-center', {
      module: req.params.module, config,
      modules: await importExport.getModules(),
      filters: await importExport.getFilterOptions()
    });
  } catch (err) { next(err); }
});

router.get('/export-center/:module/download', authRequired, perm('reports.view'), mod('reports'), async (req, res, next) => {
  try {
    const module = req.params.module;
    const format = req.query.format || 'csv';
    const filters = { ...req.query };
    delete filters.format;
    try {
      const rows = (await importExport.exportFiltered(module, filters)).map(importExport.rowIterator);
      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=${module}-${timestampSlug()}.json`);
        return res.send(JSON.stringify(rows, null, 2));
      }
      sendCsv(res, `${module}-${timestampSlug()}.csv`, rows);
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/export-center/' + module));
    }
  } catch (err) { next(err); }
});

// ─── Quick exports ───
router.get('/export/:type', authRequired, perm('reports.view'), mod('reports'), async (req, res, next) => {
  try {
    try {
      const rows = await platformService.exportRows(req.params.type);
      const format = req.query.format || 'csv';
      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=${req.params.type}-${timestampSlug()}.json`);
        return res.send(JSON.stringify(rows, null, 2));
      }
      sendCsv(res, `${req.params.type}-${timestampSlug()}.csv`, rows);
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/reports'));
    }
  } catch (err) { next(err); }
});

// ─── Advanced ───
router.get('/advanced', authRequired, perm('reports.manage'), mod('reports'), async (req, res, next) => {
  try {
    res.renderPage('platform/advanced', {
      purchase_orders: await platformService.purchaseOrders(),
      reservations: await platformService.reservations(),
      attachments: await platformService.attachments(),
      references: await platformService.advancedReferences(),
      active_tab: 'advanced'
    });
  } catch (err) { next(err); }
});

router.post('/advanced/purchase-orders', authRequired, csrfProtect, perm('reports.manage'), mod('reports'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await platformService.createPurchaseOrder(sanitizeBody(req.body), user.id);
      req.flash('success', 'Purchase order created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/advanced'));
  } catch (err) { next(err); }
});

router.post('/advanced/reservations', authRequired, csrfProtect, perm('reports.manage'), mod('reports'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await platformService.createReservation(sanitizeBody(req.body), user.id);
      req.flash('success', 'Reservation created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/advanced'));
  } catch (err) { next(err); }
});

router.post('/advanced/attachments', authRequired, csrfProtect, perm('reports.manage'), mod('reports'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    try {
      await platformService.createAttachment(sanitizeBody(req.body), user.id);
      req.flash('success', 'Attachment link created.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/advanced'));
  } catch (err) { next(err); }
});

// ─── Data Transfer ───
router.get('/data-transfer', authRequired, perm('reports.view'), async (req, res, next) => {
  try {
    res.renderPage('data_transfer/hub', { tables: dataTransfer.TABLES });
  } catch (err) { next(err); }
});

router.get('/data-transfer/export', authRequired, perm('reports.view'), async (req, res, next) => {
  try {
    const table = req.query.table || 'assets';
    let columns = [];
    try { columns = await dataTransfer.getTableColumns(table); } catch (_) {}
    res.renderPage('data_transfer/export-builder', {
      tables: dataTransfer.TABLES, currentTable: table, columns
    });
  } catch (err) { next(err); }
});

router.post('/data-transfer/export/process', authRequired, csrfProtect, perm('reports.view'), async (req, res, next) => {
  try {
    const table = req.body.table;
    try {
      let columns = req.body.columns || [];
      if (!Array.isArray(columns)) columns = [columns];
      const rawFilters = req.body.filters || {};
      const cols = Array.isArray(rawFilters.column) ? rawFilters.column : (rawFilters.column ? [rawFilters.column] : []);
      const ops = Array.isArray(rawFilters.operator) ? rawFilters.operator : (rawFilters.operator ? [rawFilters.operator] : []);
      const vals = Array.isArray(rawFilters.value) ? rawFilters.value : (rawFilters.value ? [rawFilters.value] : []);
      const filters = cols.map((c, i) => ({ column: c, operator: ops[i] || '=', value: vals[i] || '' })).filter(f => f.column);
      const rows = await dataTransfer.exportRows(table, columns, filters);
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      sendCsv(res, `advanced-export-${table}-${stamp}.csv`, rows);
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/data-transfer/export'));
    }
  } catch (err) { next(err); }
});

router.get('/data-transfer/import', authRequired, perm('reports.create'), async (req, res, next) => {
  try {
    const table = req.query.table || 'assets';
    res.renderPage('data_transfer/import-mapper', {
      tables: dataTransfer.TABLES, currentTable: table,
      csvHeaders: null, csvPreview: [], dbColumns: [], filepath: ''
    });
  } catch (err) { next(err); }
});

router.post('/data-transfer/import/upload', authRequired, upload.single('csv_file'), csrfProtect, perm('reports.create'), async (req, res, next) => {
  try {
    const table = req.body.table || 'assets';
    if (!req.file) {
      req.flash('error', 'Please upload a valid CSV file.');
      return res.redirect(hamsUrl('/data-transfer/import?table=' + table));
    }
    try {
      const dir = dataTransfer.tempDir();
      const filepath = path.join(dir, `import_${Date.now().toString(36)}.csv`);
      fs.writeFileSync(filepath, req.file.buffer);
      const { headers, preview } = dataTransfer.parseCsvForMapping(filepath);
      res.renderPage('data_transfer/import-mapper', {
        tables: dataTransfer.TABLES, currentTable: table,
        csvHeaders: headers, csvPreview: preview,
        dbColumns: await dataTransfer.getTableColumns(table),
        filepath
      });
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/data-transfer/import?table=' + table));
    }
  } catch (err) { next(err); }
});

router.post('/data-transfer/import/execute', authRequired, csrfProtect, perm('reports.create'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const table = req.body.table;
    const filepath = req.body.filepath;
    if (!filepath || !fs.existsSync(filepath)) {
      req.flash('error', 'Session expired or file missing.');
      return res.redirect(hamsUrl('/data-transfer/import'));
    }
    try {
      const result = await dataTransfer.executeMappedImport(table, filepath, req.body.mapping || {}, user.id);
      try { fs.unlinkSync(filepath); } catch (_) {}
      req.flash('success', `Import completed: ${result.imported} records created, ${result.failed} failed.`);
      res.redirect(hamsUrl('/data-transfer'));
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/data-transfer/import?table=' + table));
    }
  } catch (err) { next(err); }
});

module.exports = router;
