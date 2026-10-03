// License Allocation & Utilization (License Management) data layer.
// Everything is filtered by the optional client_name / market_name dimensions
// added to software_assets. "Allocated" means the license record carries an
// allocated_user_id; user names are ALWAYS resolved by joining users (the
// existing directory), never stored or hardcoded.
const db = require('../core/db');

// Dropdown options, straight from the data so new values appear automatically.
// `software` is used only by the Budget & Cost Forecast section's optional
// third filter; the original allocation dashboard ignores it.
async function filterOptions() {
  const clients = await db.query(
    `SELECT DISTINCT client_name FROM software_assets WHERE client_name IS NOT NULL ORDER BY 1`);
  const markets = await db.query(
    `SELECT DISTINCT market_name FROM software_assets WHERE market_name IS NOT NULL ORDER BY 1`);
  const software = await db.query(
    `SELECT DISTINCT sw_name FROM software_assets ORDER BY 1`);
  return {
    clients: clients.map(r => r.client_name),
    markets: markets.map(r => r.market_name),
    software: software.map(r => r.sw_name)
  };
}

// Shared client/market(/software) WHERE-fragment builder — reused by both the
// allocation dashboard and the budget forecast service so the two sections
// never drift on what a given filter combination means.
function filterSql(client, market, params, software) {
  let sql = '';
  if (client) { params.push(client); sql += ` AND s.client_name = $${params.length}`; }
  if (market) { params.push(market); sql += ` AND s.market_name = $${params.length}`; }
  if (software) { params.push(software); sql += ` AND s.sw_name = $${params.length}`; }
  return sql;
}

// One round trip for the whole dashboard: KPIs, bar-chart series and the
// allocation records the table renders (client-side KPI clicks just filter
// the records array — no extra query needed).
async function dashboard(client, market) {
  const params = [];
  const where = filterSql(client, market, params);

  const kpis = await db.get(
    `SELECT COUNT(DISTINCT s.sw_name)::int AS total_software,
            COUNT(*) FILTER (WHERE s.allocated_user_id IS NOT NULL)::int AS allocated,
            COUNT(*) FILTER (WHERE s.allocated_user_id IS NULL)::int AS not_allocated
       FROM software_assets s
      WHERE TRUE${where}`, params);

  const chart = await db.query(
    `SELECT s.sw_name, SUM(s.qty)::int AS qty
       FROM software_assets s
      WHERE TRUE${where}
      GROUP BY s.sw_name ORDER BY qty DESC`, params);

  const records = await db.query(
    `SELECT s.sw_name, s.qty, s.market_name, s.client_name,
            (s.allocated_user_id IS NOT NULL) AS allocated,
            u.name AS user_name
       FROM software_assets s
       LEFT JOIN users u ON s.allocated_user_id = u.id
      WHERE TRUE${where}
      ORDER BY u.name NULLS LAST, s.sw_name`, params);

  return {
    kpis: {
      totalSoftware: kpis.total_software,
      allocated: kpis.allocated,
      notAllocated: kpis.not_allocated
    },
    chart: chart.map(r => ({ name: r.sw_name, qty: r.qty })),
    records: records.map(r => ({
      user: r.user_name,          // null when unallocated -> view shows "Unassigned"
      software: r.sw_name,
      qty: r.qty,
      market: r.market_name,
      client: r.client_name,
      allocated: r.allocated
    }))
  };
}

module.exports = { filterOptions, dashboard, filterSql };
