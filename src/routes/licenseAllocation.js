// License Allocation & Utilization (License Management): client/market
// filtered KPIs, software-vs-quantity bar chart, allocation table, and the
// Budget & Cost Forecast section (spend/savings/prediction + editable prices).
// GET /license-allocation renders the page; GET /license-allocation/data
// serves JSON so the whole page refreshes without a page reload.
// Gated like the rest of License Management (licenses.view + licenses module).
const express = require('express');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const allocationService = require('../services/licenseAllocationService');
const budgetService = require('../services/licenseBudgetService');
const exchangeRateService = require('../services/exchangeRateService');
const { hamsUrl, sanitizeBody } = require('../core/helpers');

const router = express.Router();

// Validate filters against actual data values; anything unknown means "all".
// `software` only matters to the Budget & Cost Forecast section.
async function readFilters(req) {
  const options = await allocationService.filterOptions();
  return {
    options,
    client: options.clients.includes(req.query.client) ? req.query.client : null,
    market: options.markets.includes(req.query.market) ? req.query.market : null,
    software: options.software.includes(req.query.software) ? req.query.software : null
  };
}

async function loadDashboard(client, market, software) {
  const [allocation, budget, prices, rate] = await Promise.all([
    allocationService.dashboard(client, market),
    budgetService.budgetDashboard(client, market, software),
    budgetService.getPrices(client, market, software),
    exchangeRateService.getUsdInrRate()
  ]);
  return { allocation, budget, prices, rate };
}

router.get('/license-allocation', authRequired, perm('licenses.view'), mod('licenses'), async (req, res, next) => {
  try {
    const { options, client, market, software } = await readFilters(req);
    res.renderPage('software/allocation', {
      options, client, market, software,
      data: await loadDashboard(client, market, software),
      hamsUrl
    });
  } catch (err) { next(err); }
});

router.get('/license-allocation/data', authRequired, perm('licenses.view'), mod('licenses'), async (req, res, next) => {
  try {
    const { client, market, software } = await readFilters(req);
    res.json(await loadDashboard(client, market, software));
  } catch (err) { next(err); }
});

// Admin price edit: persists immediately; the client refetches /data right
// after so every KPI/chart/table reflects the new price with no page reload.
router.post('/license-allocation/prices', authRequired, csrfProtect, perm('licenses.edit'), mod('licenses'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const body = sanitizeBody(req.body);
    try {
      await budgetService.upsertPrice(body.sw_name, body.unit_price, actor.id);
      res.json({ success: true });
    } catch (err) {
      res.status(err.status || 422).json({ success: false, error: err.message });
    }
  } catch (err) { next(err); }
});

module.exports = router;
