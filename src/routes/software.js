// Software tab (License Management): renewals, subscriptions, renewal
// concentration and a details table — all driven by a start/end date range
// plus cross-filters (sw, cycle) set by clicking chart elements.
// Gated like the rest of License Management (licenses.view + licenses module).
const express = require('express');
const multer = require('multer');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const config = require('../config');
const softwareService = require('../services/softwareService');
const softwareImport = require('../services/softwareImportService');
const { hamsUrl } = require('../core/helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CYCLES = ['Annual', '6 Months', 'Perpetual', softwareService.OWNED];

router.get('/software', authRequired, perm('licenses.view'), mod('licenses'), async (req, res, next) => {
  try {
    const def = await softwareService.defaultRange();
    let start = ISO.test(req.query.start || '') ? req.query.start : def.start;
    let end = ISO.test(req.query.end || '') ? req.query.end : def.end;
    if (start > end) [start, end] = [end, start]; // tolerate swapped inputs

    // Cross-filters from chart clicks; validated against known values.
    // bucket ('YYYY-MM' or 'YYYY-MM-DD') = renewal period picked on the renewal
    // chart — it narrows the data WITHOUT changing the user's start/end range.
    const names = await softwareService.softwareNames();
    const filters = {
      sw: names.includes(req.query.sw) ? req.query.sw : null,
      cycle: CYCLES.includes(req.query.cycle) ? req.query.cycle : null,
      bucket: /^\d{4}-\d{2}(-\d{2})?$/.test(req.query.bucket || '') ? req.query.bucket : null
    };

    const [renewals, subscriptions, distribution, details] = await Promise.all([
      softwareService.renewalSeries(start, end, filters),
      softwareService.subscriptionSeries(start, end, filters),
      softwareService.renewalDistribution(start, end, filters),
      softwareService.detailsTable(start, end, filters)
    ]);

    res.renderPage('software/index', {
      start, end, dataMin: def.dataMin, dataMax: def.dataMax,
      filters, softwareNames: names,
      renewals, subscriptions, distribution, details,
      usdInrRate: config.usdInrRate, hamsUrl,
      importPreview: req.session._software_import_preview || null,
      qtyMin: softwareImport.QTY_MIN, qtyMax: softwareImport.QTY_MAX
    });
  } catch (err) { next(err); }
});

// ─── Software bulk import (CSV or Excel) ───
router.get('/software/import/template', authRequired, perm('licenses.create'), mod('licenses'), (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=software-import-template.csv');
  res.send(softwareImport.csvTemplate());
});

router.post('/software/import/preview', authRequired, upload.single('file'), csrfProtect, perm('licenses.create'), mod('licenses'), async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Please choose a CSV or Excel file to upload.');
      return res.redirect(hamsUrl('/software'));
    }
    try {
      const parsed = softwareImport.parseUpload(req.file.buffer, req.file.originalname);
      const validation = softwareImport.validateRows(parsed.rows);
      req.session._software_import_preview = {
        fileName: req.file.originalname, total: parsed.total,
        mappedColumns: parsed.mappedColumns,
        valid_rows: validation.valid, errors: validation.errors.slice(0, 25),
        error_count: validation.error_count, valid_count: validation.valid_count
      };
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/software'));
  } catch (err) { next(err); }
});

router.post('/software/import/execute', authRequired, csrfProtect, perm('licenses.create'), mod('licenses'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const preview = req.session._software_import_preview;
    delete req.session._software_import_preview;
    if (!preview || !preview.valid_rows || !preview.valid_rows.length) {
      req.flash('error', 'No valid rows to import. Please re-upload your file.');
      return res.redirect(hamsUrl('/software'));
    }
    const result = await softwareImport.executeImport(preview.valid_rows, actor.id);
    let msg = `Software import complete: ${result.imported} of ${result.total} rows imported.`;
    if (result.failed > 0) msg += ` ${result.failed} rows failed.`;
    req.flash(result.failed > 0 ? 'error' : 'success', msg);
    res.redirect(hamsUrl('/software'));
  } catch (err) { next(err); }
});

router.post('/software/import/cancel', authRequired, csrfProtect, perm('licenses.create'), mod('licenses'), (req, res) => {
  delete req.session._software_import_preview;
  res.redirect(hamsUrl('/software'));
});

module.exports = router;
