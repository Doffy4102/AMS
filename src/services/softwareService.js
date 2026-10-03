// Software tab (License Management) data layer. All reads are filtered by the
// user-selected [startDate, endDate] range plus optional cross-filters set by
// clicking chart elements: sw (software name) and cycle (renewal cycle series).
// Renewal semantics: renewal_date is precomputed at import (subscription end,
// else purchase + cycle); rows with NULL renewal_date are true perpetual.
const db = require('../core/db');

// Series name used for perpetual licenses with no subscription window.
const OWNED = 'Perpetual (owned)';

// Last day of a 'YYYY-MM' month as an ISO date.
function monthEnd(ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

// Shared bucketing rule for BOTH the renewal and subscription charts: month
// buckets when the range is wide (> ~62 days), day buckets otherwise — so the
// two charts always use matching x-axis granularity.
function byMonthGranularity(start, end) {
  return (new Date(end) - new Date(start)) / 86400000 > 62;
}

// Build WHERE fragments for the cross-filters. `params` is mutated. `alias`
// prefixes column names for queries that join the table under an alias.
// bucket ('YYYY-MM' or 'YYYY-MM-DD') selects rows RENEWING in that period —
// it filters the row set without touching the user's start/end range.
function filterSql(filters = {}, params, alias = '') {
  const a = alias ? alias + '.' : '';
  let sql = '';
  if (filters.sw) { params.push(filters.sw); sql += ` AND ${a}sw_name = $${params.length}`; }
  if (filters.cycle === OWNED) {
    sql += ` AND ${a}license_type = 'Perpetual' AND ${a}subscription_start_date IS NULL`;
  } else if (filters.cycle) {
    params.push(filters.cycle); sql += ` AND ${a}renewal_name = $${params.length}`;
  }
  if (filters.bucket) {
    if (/^\d{4}-\d{2}$/.test(filters.bucket)) {
      params.push(filters.bucket + '-01', monthEnd(filters.bucket));
      sql += ` AND ${a}renewal_date BETWEEN $${params.length - 1} AND $${params.length}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(filters.bucket)) {
      params.push(filters.bucket);
      sql += ` AND ${a}renewal_date = $${params.length}`;
    }
  }
  return sql;
}

// Sensible default range when the user hasn't picked one: this year, clamped to
// the data's actual renewal bounds so the page never opens empty.
async function defaultRange() {
  const b = await db.get(
    `SELECT MIN(renewal_date)::text mn, MAX(renewal_date)::text mx FROM software_assets WHERE renewal_date IS NOT NULL`);
  const now = new Date();
  const year = now.getUTCFullYear();
  let start = `${year}-01-01`, end = `${year}-12-31`;
  if (b && b.mn && b.mx) {
    if (end < b.mn) { start = b.mn.slice(0, 4) + '-01-01'; end = b.mn.slice(0, 4) + '-12-31'; }
    if (start > b.mx) { start = b.mx.slice(0, 4) + '-01-01'; end = b.mx.slice(0, 4) + '-12-31'; }
  }
  return { start, end, dataMin: b ? b.mn : null, dataMax: b ? b.mx : null };
}

// Bucket renewals by month when the range is wide (> ~62 days), by day otherwise.
// Returns both `buckets` (bucket + total, for the x-axis/highlight/empty-check)
// and `series` — one entry per software, aligned to the same buckets — so the
// chart can render a stacked bar with each software as its own colored segment.
// NOTE: this never applies the caller's own `bucket` selection to itself —
// clicking a bar highlights it (client-side) but must never collapse the graph
// to one bar, so only sw/cycle cross-filters narrow this query.
async function renewalSeries(start, end, filters = {}) {
  const byMonth = byMonthGranularity(start, end);
  const bucket = byMonth ? `TO_CHAR(renewal_date, 'YYYY-MM')` : `renewal_date::text`;
  const params = [start, end];
  const rows = await db.query(
    `SELECT ${bucket} AS bucket, sw_name, SUM(qty)::int AS qty
       FROM software_assets
      WHERE renewal_date BETWEEN $1 AND $2${filterSql({ sw: filters.sw, cycle: filters.cycle }, params)}
      GROUP BY 1, sw_name ORDER BY 1, sw_name`, params);

  const bucketList = [...new Set(rows.map(r => r.bucket))].sort();
  const idx = new Map(bucketList.map((b, i) => [b, i]));
  const totals = new Array(bucketList.length).fill(0);
  const bySw = new Map();
  for (const r of rows) {
    const i = idx.get(r.bucket);
    totals[i] += r.qty;
    if (!bySw.has(r.sw_name)) bySw.set(r.sw_name, new Array(bucketList.length).fill(0));
    bySw.get(r.sw_name)[i] = r.qty;
  }
  const series = [...bySw.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, data]) => ({ name, data }));
  const buckets = bucketList.map((b, i) => ({ bucket: b, total: totals[i] }));
  return { byMonth, buckets, series };
}

// Quantity of licenses RENEWING in each renewal bucket, stacked by renewal cycle
// (Annual / 6 Months / Perpetual). The chart is driven entirely by renewal_date:
// a bucket appears ONLY if something renews in it, and each bar's height is the
// renewing quantity for that period — never total active coverage. So the x-axis
// and the bar values both track the Upcoming Renewals chart bucket-for-bucket.
// Rows with no renewal_date (true perpetual/owned) never appear here.
// When a renewal-bar bucket is selected the range narrows to that period.
async function subscriptionSeries(start, end, filters = {}) {
  // Narrow the range to the selected bucket period (clamped to start/end).
  let seriesStart = start, seriesEnd = end;
  if (filters.bucket) {
    if (/^\d{4}-\d{2}$/.test(filters.bucket)) {
      seriesStart = filters.bucket + '-01';
      seriesEnd = monthEnd(filters.bucket);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(filters.bucket)) {
      seriesStart = filters.bucket;
      seriesEnd = filters.bucket;
    }
    if (seriesStart < start) seriesStart = start;
    if (seriesEnd > end) seriesEnd = end;
  }

  const byMonth = byMonthGranularity(seriesStart, seriesEnd);
  const bucketExpr = byMonth ? `TO_CHAR(renewal_date, 'YYYY-MM')` : `renewal_date::text`;

  // One row per (renewal bucket, cycle) with the renewing quantity. sw/cycle
  // cross-filters apply exactly as on the renewal chart; the range clamp above
  // handles a selected bucket, so we don't re-apply it here.
  const params = [seriesStart, seriesEnd];
  const extra = filterSql({ sw: filters.sw, cycle: filters.cycle }, params);
  const rows = await db.query(
    `SELECT ${bucketExpr} AS x, renewal_name,
            SUM(qty)::int AS qty,
            COALESCE(STRING_AGG(DISTINCT sw_name, '|'), '') AS names
       FROM software_assets
      WHERE renewal_date BETWEEN $1 AND $2${extra}
      GROUP BY 1, renewal_name ORDER BY 1, renewal_name`, params);

  // Pivot into stacked series (one per cycle) over the sorted renewal buckets.
  const labels = [...new Set(rows.map(r => r.x))].sort();
  const idx = new Map(labels.map((l, i) => [l, i]));
  const byCycle = new Map();
  for (const r of rows) {
    if (!byCycle.has(r.renewal_name)) {
      byCycle.set(r.renewal_name, {
        name: r.renewal_name,
        data: new Array(labels.length).fill(0),
        names: new Array(labels.length).fill('')
      });
    }
    const s = byCycle.get(r.renewal_name);
    const i = idx.get(r.x);
    s.data[i] = r.qty;
    s.names[i] = r.names;
  }
  const cycleOrder = ['Annual', '6 Months', 'Perpetual'];
  const series = [...byCycle.values()].sort(
    (a, b) => cycleOrder.indexOf(a.name) - cycleOrder.indexOf(b.name));
  return { labels, series, byMonth };
}

// Renewal concentration: qty due per software within range (pie).
async function renewalDistribution(start, end, filters = {}) {
  const params = [start, end];
  return db.query(
    `SELECT sw_name, SUM(qty)::int AS qty
       FROM software_assets
      WHERE renewal_date BETWEEN $1 AND $2${filterSql(filters, params)}
      GROUP BY sw_name ORDER BY qty DESC`, params);
}

// Details table: one row per software, aggregated over rows relevant to the
// range (renewal in range, or subscription overlapping it, or perpetual bought
// before range end). Amounts are INR; the view converts for display.
async function detailsTable(start, end, filters = {}) {
  const params = [start, end];
  const extra = filterSql(filters, params);
  return db.query(
    `SELECT sw_name,
            SUM(qty)::int AS total_qty,
            SUM(amount)::numeric(14,2) AS total_amount,
            STRING_AGG(DISTINCT license_type, ', ') AS license_types,
            STRING_AGG(DISTINCT COALESCE(vendor_name, 'Unknown'), ', ') AS vendors,
            COUNT(*) AS records,
            MIN(renewal_date) FILTER (WHERE renewal_date BETWEEN $1 AND $2)::text AS next_renewal
       FROM software_assets
      WHERE ((renewal_date BETWEEN $1 AND $2)
         OR (subscription_start_date <= $2 AND subscription_end_date >= $1)
         OR (subscription_start_date IS NULL AND license_type = 'Perpetual' AND purchase_date <= $2))${extra}
      GROUP BY sw_name ORDER BY total_amount DESC NULLS LAST`, params);
}

// Distinct software names (for the table filter dropdown / validation).
async function softwareNames() {
  const rows = await db.query('SELECT DISTINCT sw_name FROM software_assets ORDER BY sw_name');
  return rows.map(r => r.sw_name);
}

module.exports = { defaultRange, renewalSeries, subscriptionSeries, renewalDistribution, detailsTable, softwareNames, OWNED };
