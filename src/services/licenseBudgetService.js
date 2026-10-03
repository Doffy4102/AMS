// Budget & Cost Forecast (License Allocation & Utilization -> Budget & Cost
// Forecast section). Reuses licenseAllocationService's client/market/software
// filter builder so both sections of the page can never drift on what a
// filter combination means. All money is computed and stored in INR — the
// view converts to USD client-side using the live exchangeRateService rate,
// exactly like the existing Software tab's currency toggle.
//
// Pricing: software_prices holds one editable unit price per software
// (seeded from historical amount/qty, admin-editable afterward). A software
// with no price yet (unit_price IS NULL) is excluded from money totals but
// still counted in the license/allocation KPIs, and flagged so the UI can
// prompt an admin to set it.
//
// Growth model (no hardcoded/random values):
//   1) Historical: if the filtered scope has >=2 distinct purchase years,
//      use the average year-over-year quantity growth rate, clamped to a
//      sane range so one noisy year can't blow up the forecast.
//   2) Fallback: if there isn't enough date history, derive a growth rate
//      from the current utilization ratio (allocated/total qty) — higher
//      utilization implies more headroom will be needed next cycle.
// Predicted Budget = Current Spending × (1 + GrowthRate) − Estimated Savings
//
// Savings = cost of unallocated quantity + cost of duplicate allocations
// (the same user allocated the same software more than once in scope — all
// but the largest such allocation per (software, user) counts as duplicate).
const db = require('../core/db');
const { filterSql } = require('./licenseAllocationService');
const { HttpError, trimStr } = require('../core/helpers');

const GROWTH_CLAMP_MIN = -0.3, GROWTH_CLAMP_MAX = 0.5;
const UTILIZATION_GROWTH_CEILING = 0.15; // max growth rate implied by utilization alone

async function getPrices(client, market, software) {
  const params = [];
  const where = filterSql(client, market, params, software);
  return db.query(
    `SELECT p.sw_name, p.unit_price, p.currency, p.updated_at, u.name AS updated_by_name
       FROM software_prices p
       LEFT JOIN users u ON p.updated_by = u.id
      WHERE p.sw_name IN (SELECT DISTINCT s.sw_name FROM software_assets s WHERE TRUE${where})
      ORDER BY p.sw_name`, params);
}

async function upsertPrice(swName, unitPrice, actorId) {
  swName = trimStr(swName);
  if (!swName) throw new HttpError('Software name is required.', 422);
  const price = Number(unitPrice);
  if (Number.isNaN(price) || price < 0) throw new HttpError('Price must be a non-negative number.', 422);
  const exists = await db.get('SELECT id FROM software_prices WHERE sw_name = $1', [swName]);
  if (exists) {
    await db.run(
      `UPDATE software_prices SET unit_price = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE sw_name = $3`,
      [price, actorId || null, swName]);
  } else {
    await db.run(
      `INSERT INTO software_prices (sw_name, unit_price, currency, updated_by) VALUES ($1, $2, 'INR', $3)`,
      [swName, price, actorId || null]);
  }
  return true;
}

// Historical YoY quantity growth for the filtered scope; null if too little
// date history exists to trust a trend.
async function historicalGrowthRate(client, market, software) {
  const params = [];
  const where = filterSql(client, market, params, software);
  const rows = await db.query(
    `SELECT EXTRACT(YEAR FROM s.purchase_date)::int AS yr, SUM(s.qty)::int AS qty
       FROM software_assets s
      WHERE s.purchase_date IS NOT NULL${where}
      GROUP BY 1 ORDER BY 1`, params);
  const years = rows.filter(r => r.qty > 0);
  if (years.length < 2) return null;
  const rates = [];
  for (let i = 1; i < years.length; i++) {
    const prev = years[i - 1].qty, curr = years[i].qty;
    if (prev > 0) rates.push((curr - prev) / prev);
  }
  if (!rates.length) return null;
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  return Math.max(GROWTH_CLAMP_MIN, Math.min(GROWTH_CLAMP_MAX, avg));
}

function utilizationGrowthRate(allocatedQty, totalQty) {
  if (totalQty <= 0) return 0;
  return (allocatedQty / totalQty) * UTILIZATION_GROWTH_CEILING;
}

async function budgetDashboard(client, market, software) {
  const params = [];
  const where = filterSql(client, market, params, software);

  // Per-software rollup joined to price (LEFT so unpriced software still
  // shows up in license-count KPIs and the cost-analysis table).
  const perSoftware = await db.query(
    `SELECT s.sw_name,
            SUM(s.qty)::int AS qty,
            SUM(s.qty) FILTER (WHERE s.allocated_user_id IS NOT NULL)::int AS allocated_qty,
            SUM(s.qty) FILTER (WHERE s.allocated_user_id IS NULL)::int AS unallocated_qty,
            p.unit_price
       FROM software_assets s
       LEFT JOIN software_prices p ON p.sw_name = s.sw_name
      WHERE TRUE${where}
      GROUP BY s.sw_name, p.unit_price
      ORDER BY s.sw_name`, params);

  // Duplicate allocations: same user allocated the same software more than
  // once in this scope — every allocation past the single largest one is
  // redundant spend.
  const dupParams = [];
  const dupWhere = filterSql(client, market, dupParams, software);
  const dupGroups = await db.query(
    `SELECT s.sw_name, SUM(s.qty)::int AS total_qty, MAX(s.qty)::int AS max_qty
       FROM software_assets s
      WHERE s.allocated_user_id IS NOT NULL${dupWhere}
      GROUP BY s.sw_name, s.allocated_user_id
     HAVING COUNT(*) > 1`, dupParams);
  const duplicateQtyBySw = new Map();
  for (const g of dupGroups) {
    const extra = g.total_qty - g.max_qty;
    duplicateQtyBySw.set(g.sw_name, (duplicateQtyBySw.get(g.sw_name) || 0) + extra);
  }

  let totalLicenses = 0, allocatedLicenses = 0, unallocatedLicenses = 0;
  let totalSpending = 0, unallocatedCost = 0, duplicateCost = 0;
  const costAnalysis = [];
  const missingPriceSoftware = [];

  for (const r of perSoftware) {
    const qty = r.qty || 0, allocQty = r.allocated_qty || 0, unallocQty = r.unallocated_qty || 0;
    totalLicenses += qty; allocatedLicenses += allocQty; unallocatedLicenses += unallocQty;
    const price = r.unit_price != null ? Number(r.unit_price) : null;
    const missingPrice = price === null;
    if (missingPrice) missingPriceSoftware.push(r.sw_name);

    const totalCost = missingPrice ? 0 : price * qty;
    const dupQty = duplicateQtyBySw.get(r.sw_name) || 0;
    const swUnallocatedCost = missingPrice ? 0 : price * unallocQty;
    const swDuplicateCost = missingPrice ? 0 : price * dupQty;

    totalSpending += totalCost;
    unallocatedCost += swUnallocatedCost;
    duplicateCost += swDuplicateCost;

    costAnalysis.push({
      name: r.sw_name, qty, totalCost,
      savingsOpportunity: swUnallocatedCost + swDuplicateCost,
      missingPrice
    });
  }

  const estimatedSavings = unallocatedCost + duplicateCost;
  const historicalRate = await historicalGrowthRate(client, market, software);
  const growthRate = historicalRate !== null ? historicalRate : utilizationGrowthRate(allocatedLicenses, totalLicenses);
  const growthSource = historicalRate !== null ? 'historical' : 'utilization';
  const expectedGrowthAmount = totalSpending * growthRate;
  const predictedBudget = Math.max(0, totalSpending + expectedGrowthAmount - estimatedSavings);

  return {
    kpis: {
      totalSoftware: perSoftware.length,
      totalLicenses, allocatedLicenses, unallocatedLicenses,
      totalSpending,
      spendingPerAllocatedLicense: allocatedLicenses > 0 ? totalSpending / allocatedLicenses : null
    },
    forecast: {
      currentSpending: totalSpending,
      growthRate, growthSource,
      expectedGrowthAmount,
      estimatedSavings,
      unallocatedCost, duplicateCost,
      predictedBudget
    },
    costAnalysis,
    missingPriceCount: missingPriceSoftware.length,
    missingPriceSoftware
  };
}

module.exports = { getPrices, upsertPrice, budgetDashboard };
