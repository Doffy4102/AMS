// REST API V1 (port of routes/api.php + Api\V1\AssetController).
const express = require('express');
const assetService = require('../services/assetService');
const webhookService = require('../services/webhookService');
const { apiTokenAuth } = require('../middleware/apiToken');
const { validate } = require('../core/validator');
const { intOr } = require('../core/helpers');

const router = express.Router();

router.get('/api/v1/assets', apiTokenAuth, async (req, res, next) => {
  try {
    const limit = intOr(req.query.limit, 50);
    const offset = intOr(req.query.offset, 0);
    const rows = await assetService.fetch(limit, offset, req.query);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.get('/api/v1/assets/:id', apiTokenAuth, async (req, res, next) => {
  try {
    const asset = await assetService.find(intOr(req.params.id));
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    res.json({ success: true, data: asset });
  } catch (err) { next(err); }
});

router.post('/api/v1/assets', apiTokenAuth, async (req, res, next) => {
  try {
    const data = { ...req.query, ...req.body };
    const v = validate(data, {
      name: 'required|max:255',
      asset_tag: 'max:255',
      serial_number: 'required|max:255',
      status: 'in:available,assigned,repair,archived'
    });
    if (v.fails) return res.status(422).json({ success: false, errors: v.errors });
    data.custom_fields_data = data.custom_fields_data || {};
    const id = await assetService.createAsset(data);
    if (id) {
      await webhookService.dispatch('asset.created', data);
      return res.status(201).json({ success: true, message: 'Asset created successfully' });
    }
    res.status(500).json({ success: false, error: 'Failed to create asset' });
  } catch (err) { next(err); }
});

router.post('/api/v1/assets/:id/update', apiTokenAuth, async (req, res, next) => {
  try {
    const id = intOr(req.params.id);
    const asset = await assetService.find(id);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const merged = { ...asset, ...req.query, ...req.body };
    const v = validate(merged, {
      name: 'required|max:255',
      serial_number: 'required|max:255',
      status: 'in:available,assigned,repair,archived'
    });
    if (v.fails) return res.status(422).json({ success: false, errors: v.errors });
    try {
      await assetService.updateAsset(id, merged, { id: req.session.user_id });
      await webhookService.dispatch('asset.updated', { id, data: merged });
      return res.json({ success: true, message: 'Asset updated successfully' });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Failed to update asset' });
    }
  } catch (err) { next(err); }
});

router.post('/api/v1/assets/:id/delete', apiTokenAuth, async (req, res, next) => {
  try {
    const id = intOr(req.params.id);
    const asset = await assetService.find(id);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    if (await assetService.deleteAsset(id, { id: req.session.user_id })) {
      await webhookService.dispatch('asset.deleted', { id });
      return res.json({ success: true, message: 'Asset deleted successfully' });
    }
    res.status(500).json({ success: false, error: 'Failed to delete asset' });
  } catch (err) { next(err); }
});

module.exports = router;
