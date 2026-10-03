// HAMS AI Assistant: answers natural-language questions about the
// application's own data. Pipeline per query — understand intent, extract
// entities (client / market / software / date range), run the matching SQL
// or reuse an existing service, and return a STRUCTURED answer:
//   { summary, metrics[], table{columns,rows}, insights[], recommendations[] }
// Every number comes from the live database — nothing is fabricated; when the
// data can't answer, the assistant says exactly what's missing. Permission
// flags (computed by the route from the signed-in user) gate each data domain.
const db = require('../core/db');
const budgetService = require('./licenseBudgetService');
const exchangeRateService = require('./exchangeRateService');

// ─────────────────────────── Entity extraction ───────────────────────────

// Small edit-distance for typo tolerance ("HMP2" -> "HMT2", "athina" -> "Athena").
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Match a known value inside the question: exact substring first, then a
// fuzzy pass over the question's word n-grams (edit distance <= 1 squashed).
function findEntity(question, candidates) {
  const q = question.toLowerCase();
  const qSquash = squash(question);
  // exact (longest candidates first so "UnitedHealth Group" beats "Health")
  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  for (const c of ordered) {
    if (q.includes(c.toLowerCase()) || qSquash.includes(squash(c))) return c;
  }
  // fuzzy over word windows
  const words = q.split(/[^a-z0-9()]+/).filter(Boolean);
  for (const c of ordered) {
    const cs = squash(c);
    if (cs.length < 3) continue;
    const win = Math.max(1, Math.min(4, c.split(/\s+/).length));
    for (let size = win; size >= 1; size--) {
      for (let i = 0; i + size <= words.length; i++) {
        const gram = squash(words.slice(i, i + size).join(''));
        if (Math.abs(gram.length - cs.length) <= 2 && editDistance(gram, cs) <= 1) return c;
      }
    }
  }
  return null;
}

async function entityDictionaries() {
  const [clients, markets, software] = await Promise.all([
    db.query(`SELECT DISTINCT client_name v FROM software_assets WHERE client_name IS NOT NULL`),
    db.query(`SELECT DISTINCT market_name v FROM software_assets WHERE market_name IS NOT NULL`),
    db.query(`SELECT DISTINCT sw_name v FROM software_assets`)
  ]);
  return {
    clients: clients.map(r => r.v),
    markets: markets.map(r => r.v),
    software: software.map(r => r.v)
  };
}

// ───────────────────────────── Date parsing ─────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const iso = d => d.toISOString().slice(0, 10);

function parseDateRange(q) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const qtr = Math.floor(m / 3);
  const range = (s, e, label) => ({ start: iso(s), end: iso(e), label });
  const utc = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd));

  if (/last\s+quarter/.test(q)) {
    const s = utc(y, (qtr - 1) * 3, 1);
    return range(s, utc(s.getUTCFullYear(), s.getUTCMonth() + 3, 0), 'last quarter');
  }
  if (/this\s+quarter|current\s+quarter/.test(q)) {
    return range(utc(y, qtr * 3, 1), utc(y, qtr * 3 + 3, 0), 'this quarter');
  }
  if (/last\s+month/.test(q)) return range(utc(y, m - 1, 1), utc(y, m, 0), 'last month');
  if (/this\s+month|current\s+month/.test(q)) return range(utc(y, m, 1), utc(y, m + 1, 0), 'this month');
  if (/last\s+year/.test(q)) return range(utc(y - 1, 0, 1), utc(y - 1, 11, 31), 'last year');
  if (/this\s+year|current\s+year/.test(q)) return range(utc(y, 0, 1), utc(y, 11, 31), 'this year');
  if (/next\s+(90|ninety)\s*days/.test(q)) return range(now, utc(y, m, now.getUTCDate() + 90), 'next 90 days');
  if (/next\s+(30|thirty)\s*days/.test(q)) return range(now, utc(y, m, now.getUTCDate() + 30), 'next 30 days');
  if (/next\s+month/.test(q)) return range(utc(y, m + 1, 1), utc(y, m + 2, 0), 'next month');
  if (/next\s+quarter/.test(q)) {
    const s = utc(y, (qtr + 1) * 3, 1);
    return range(s, utc(s.getUTCFullYear(), s.getUTCMonth() + 3, 0), 'next quarter');
  }
  for (let i = 0; i < 12; i++) {
    const re = new RegExp('\\b' + MONTHS[i] + '\\b(\\s+(\\d{4}))?');
    const match = q.match(re);
    if (match) {
      const yy = match[2] ? parseInt(match[2], 10) : y;
      return range(utc(yy, i, 1), utc(yy, i + 1, 0), MONTHS[i] + ' ' + yy);
    }
  }
  const yr = q.match(/\b(20\d{2})\b/);
  if (yr) {
    const yy = parseInt(yr[1], 10);
    return range(utc(yy, 0, 1), utc(yy, 11, 31), 'year ' + yy);
  }
  return null;
}

// ───────────────────────────── Formatting ─────────────────────────────

const fmtInt = n => Number(n || 0).toLocaleString('en-IN');
const fmtInr = n => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');
function scopeLabel(e) {
  const bits = [];
  if (e.client) bits.push('client ' + e.client);
  if (e.market) bits.push('market ' + e.market);
  if (e.software) bits.push(e.software);
  if (e.range) bits.push(e.range.label);
  return bits.length ? ' (' + bits.join(', ') + ')' : '';
}
function swWhere(e, params) {
  let sql = '';
  if (e.client) { params.push(e.client); sql += ` AND s.client_name = $${params.length}`; }
  if (e.market) { params.push(e.market); sql += ` AND s.market_name = $${params.length}`; }
  if (e.software) { params.push(e.software); sql += ` AND s.sw_name = $${params.length}`; }
  return sql;
}

// ───────────────────────────── Intents ─────────────────────────────

async function countOrListSoftware(q, e, wantList) {
  const params = [];
  const where = swWhere(e, params);
  const rows = await db.query(
    `SELECT s.sw_name, SUM(s.qty)::int AS qty,
            SUM(s.qty) FILTER (WHERE s.allocated_user_id IS NOT NULL)::int AS allocated,
            COUNT(*)::int AS records
       FROM software_assets s WHERE TRUE${where}
      GROUP BY s.sw_name ORDER BY qty DESC`, params);
  const totalQty = rows.reduce((a, r) => a + r.qty, 0);
  const answer = {
    summary: rows.length
      ? `There ${rows.length === 1 ? 'is' : 'are'} ${rows.length} software product${rows.length === 1 ? '' : 's'}${scopeLabel(e)}, totalling ${fmtInt(totalQty)} licenses.`
      : `No software found${scopeLabel(e)}.`,
    metrics: [
      { label: 'Software products', value: fmtInt(rows.length) },
      { label: 'Total licenses', value: fmtInt(totalQty) },
      { label: 'Allocated', value: fmtInt(rows.reduce((a, r) => a + (r.allocated || 0), 0)) }
    ]
  };
  if (wantList && rows.length) {
    answer.table = {
      columns: ['Software', 'Licenses', 'Allocated', 'Records'],
      rows: rows.map(r => [r.sw_name, fmtInt(r.qty), fmtInt(r.allocated || 0), fmtInt(r.records)])
    };
  } else if (rows.length) {
    answer.insights = ['Ask "list them" style questions (e.g. "list software for ' + (e.client || 'Athena') + '") to see the product breakdown.'];
  }
  return answer;
}

async function topGroup(q, e, dim) {
  const col = dim === 'market' ? 'market_name' : 'client_name';
  const wantSpend = /spend|cost|expensive|amount|revenue/.test(q);
  const wantLowest = /lowest|least|fewest|smallest|minimum|bottom/.test(q);
  const rows = await db.query(
    `SELECT s.${col} AS grp,
            COUNT(DISTINCT s.sw_name)::int AS software,
            SUM(s.qty)::int AS qty,
            SUM(s.qty * COALESCE(p.unit_price, 0))::numeric AS spend
       FROM software_assets s
       LEFT JOIN software_prices p ON p.sw_name = s.sw_name
      WHERE s.${col} IS NOT NULL
      GROUP BY 1`);
  const key = wantSpend ? 'spend' : 'qty';
  rows.sort((a, b) => wantLowest ? a[key] - b[key] : b[key] - a[key]);
  const top = rows[0];
  if (!top) return { summary: `No ${dim} data is available yet.` };
  const metricWord = wantSpend ? 'license spending' : 'licenses';
  return {
    summary: `${top.grp} has the ${wantLowest ? 'lowest' : 'highest'} ${metricWord}: ` +
      (wantSpend ? fmtInr(top.spend) : fmtInt(top.qty) + ' licenses across ' + top.software + ' software products') + '.',
    table: {
      columns: [dim === 'market' ? 'Market' : 'Client', 'Software', 'Licenses', 'Spend (INR)'],
      rows: rows.map(r => [r.grp, fmtInt(r.software), fmtInt(r.qty), fmtInr(r.spend)])
    },
    insights: [
      `${rows[0].grp} leads; ${rows[rows.length - 1].grp} is smallest by ${wantSpend ? 'spend' : 'license count'}.`
    ]
  };
}

async function spendingBudget(q, e) {
  const d = await budgetService.budgetDashboard(e.client, e.market, e.software);
  const f = d.forecast, k = d.kpis;
  const rate = await exchangeRateService.getUsdInrRate();
  const usd = v => '$' + Math.round(v / rate.rate).toLocaleString('en-US');
  const askSavings = /saving|waste|unused|reclaim/.test(q);
  const askBudget = /budget|predict|forecast|next\s+(cycle|year)/.test(q);
  const answer = {
    summary: askSavings
      ? `Estimated savings${scopeLabel(e)} are ${fmtInr(f.estimatedSavings)} (${usd(f.estimatedSavings)}) — ${fmtInr(f.unallocatedCost)} from unallocated licenses and ${fmtInr(f.duplicateCost)} from duplicate allocations.`
      : askBudget
        ? `Predicted budget for the next licensing cycle${scopeLabel(e)} is ${fmtInr(f.predictedBudget)} (${usd(f.predictedBudget)}), from current spending of ${fmtInr(f.currentSpending)} with ${(f.growthRate * 100).toFixed(1)}% ${f.growthSource}-derived growth minus ${fmtInr(f.estimatedSavings)} savings.`
        : `Total license spending${scopeLabel(e)} is ${fmtInr(k.totalSpending)} (${usd(k.totalSpending)}) across ${fmtInt(k.totalLicenses)} licenses.`,
    metrics: [
      { label: 'Current spending', value: fmtInr(f.currentSpending) },
      { label: 'Predicted budget', value: fmtInr(f.predictedBudget) },
      { label: 'Estimated savings', value: fmtInr(f.estimatedSavings) },
      { label: 'Spend / allocated license', value: k.spendingPerAllocatedLicense ? fmtInr(k.spendingPerAllocatedLicense) : '—' }
    ],
    insights: [
      `Growth model: ${f.growthSource === 'historical' ? 'actual year-over-year purchase trend' : 'current utilization rate'} (${(f.growthRate * 100).toFixed(1)}%).`,
      `${fmtInt(k.unallocatedLicenses)} of ${fmtInt(k.totalLicenses)} licenses are unallocated.`,
      `Exchange rate used: 1 USD = ${rate.rate.toFixed(2)} INR (${rate.source}).`
    ],
    recommendations: f.estimatedSavings > 0
      ? ['Review unallocated and duplicate licenses in License Allocation & Utilization — reclaiming them funds ' +
        (f.currentSpending > 0 ? ((f.estimatedSavings / f.currentSpending) * 100).toFixed(0) : 0) + '% of current spend.']
      : []
  };
  return answer;
}

async function allocation(q, e) {
  const d = await budgetService.budgetDashboard(e.client, e.market, e.software);
  const k = d.kpis;
  const pct = k.totalLicenses ? ((k.allocatedLicenses / k.totalLicenses) * 100).toFixed(1) : '0';
  return {
    summary: `${fmtInt(k.allocatedLicenses)} of ${fmtInt(k.totalLicenses)} licenses are allocated${scopeLabel(e)} (${pct}% utilization); ${fmtInt(k.unallocatedLicenses)} are unallocated.`,
    metrics: [
      { label: 'Total licenses', value: fmtInt(k.totalLicenses) },
      { label: 'Allocated', value: fmtInt(k.allocatedLicenses) },
      { label: 'Unallocated', value: fmtInt(k.unallocatedLicenses) },
      { label: 'Utilization', value: pct + '%' }
    ],
    recommendations: k.unallocatedLicenses > 0
      ? ['Open License Allocation & Utilization and click "Not Allocated" to see exactly which licenses are idle.'] : []
  };
}

async function renewals(q, e) {
  const range = e.range || (() => {
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, now.getUTCDate()));
    return { start: iso(now), end: iso(end), label: 'next 90 days' };
  })();
  const params = [range.start, range.end];
  const where = swWhere(e, params);
  const rows = await db.query(
    `SELECT s.sw_name, MIN(s.renewal_date)::text AS next_renewal, SUM(s.qty)::int AS qty,
            SUM(s.qty * COALESCE(p.unit_price, 0))::numeric AS value
       FROM software_assets s LEFT JOIN software_prices p ON p.sw_name = s.sw_name
      WHERE s.renewal_date BETWEEN $1 AND $2${where}
      GROUP BY s.sw_name ORDER BY 2`, params);
  const totalQty = rows.reduce((a, r) => a + r.qty, 0);
  const totalVal = rows.reduce((a, r) => a + Number(r.value), 0);
  return {
    summary: rows.length
      ? `${fmtInt(totalQty)} licenses across ${rows.length} software products renew in ${range.label}${scopeLabel({ client: e.client, market: e.market })}, worth about ${fmtInr(totalVal)}.`
      : `No renewals fall in ${range.label}${scopeLabel(e)}.`,
    table: rows.length ? {
      columns: ['Software', 'Next renewal', 'Licenses renewing', 'Approx. value'],
      rows: rows.map(r => [r.sw_name, r.next_renewal, fmtInt(r.qty), fmtInr(r.value)])
    } : undefined,
    recommendations: rows.length ? ['See the Software tab (License Management) for the full renewal timeline chart.'] : []
  };
}

async function purchases(q, e) {
  const range = e.range;
  if (!range) {
    return {
      summary: 'Which period do you mean? Try "last quarter", "this year", a month name, or a year like 2025.',
      clarification: true
    };
  }
  const params = [range.start, range.end];
  const where = swWhere(e, params);
  const rows = await db.query(
    `SELECT s.sw_name, COUNT(*)::int AS purchases, SUM(s.qty)::int AS qty,
            SUM(s.amount)::numeric AS amount, MIN(s.purchase_date)::text AS first_buy, MAX(s.purchase_date)::text AS last_buy
       FROM software_assets s
      WHERE s.purchase_date BETWEEN $1 AND $2${where}
      GROUP BY s.sw_name ORDER BY amount DESC NULLS LAST`, params);
  const totAmt = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
  return {
    summary: rows.length
      ? `${rows.reduce((a, r) => a + r.purchases, 0)} purchase records across ${rows.length} products in ${range.label}${scopeLabel({ client: e.client, market: e.market })}, totalling ${fmtInr(totAmt)}.`
      : `No purchases recorded in ${range.label}${scopeLabel(e)}.`,
    table: rows.length ? {
      columns: ['Software', 'Purchases', 'Qty', 'Amount (INR)', 'First', 'Last'],
      rows: rows.map(r => [r.sw_name, fmtInt(r.purchases), fmtInt(r.qty), fmtInr(r.amount), r.first_buy, r.last_buy])
    } : undefined
  };
}

async function hardware(q, e) {
  const rows = await db.query(
    `SELECT COALESCE(c.name, a.category, 'Uncategorised') AS category,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE a.assigned_to IS NOT NULL)::int AS assigned,
            COUNT(*) FILTER (WHERE a.assigned_to IS NULL AND LOWER(a.status) = 'available')::int AS available
       FROM assets a LEFT JOIN asset_categories c ON a.category_id = c.id
      WHERE a.deleted_at IS NULL
      GROUP BY 1 ORDER BY total DESC`);
  const tot = rows.reduce((a, r) => a + r.total, 0);
  const asg = rows.reduce((a, r) => a + r.assigned, 0);
  const avl = rows.reduce((a, r) => a + r.available, 0);
  return {
    summary: `There are ${fmtInt(tot)} hardware assets: ${fmtInt(asg)} assigned to users and ${fmtInt(avl)} available in stock.`,
    metrics: [
      { label: 'Total assets', value: fmtInt(tot) },
      { label: 'Assigned', value: fmtInt(asg) },
      { label: 'Available', value: fmtInt(avl) }
    ],
    table: {
      columns: ['Category', 'Total', 'Assigned', 'Available'],
      rows: rows.map(r => [r.category, fmtInt(r.total), fmtInt(r.assigned), fmtInt(r.available)])
    }
  };
}

async function inventory(q) {
  const [acc, comp, cons, lic] = await Promise.all([
    db.get(`SELECT COUNT(*)::int items, COALESCE(SUM(total_qty),0)::int total, COALESCE(SUM(available_qty),0)::int avail FROM accessories WHERE deleted_at IS NULL`),
    db.get(`SELECT COUNT(*)::int items, COALESCE(SUM(total_qty),0)::int total, COALESCE(SUM(available_qty),0)::int avail FROM components WHERE deleted_at IS NULL`),
    db.get(`SELECT COUNT(*)::int items, COALESCE(SUM(total_qty),0)::int total, COALESCE(SUM(remaining_qty),0)::int avail FROM consumables WHERE deleted_at IS NULL`),
    db.get(`SELECT COUNT(*)::int items, COALESCE(SUM(seats),0)::int total, COALESCE(SUM(available_seats),0)::int avail FROM licenses WHERE deleted_at IS NULL`)
  ]);
  return {
    summary: `Inventory: ${fmtInt(acc.items)} accessory items, ${fmtInt(comp.items)} component items, ${fmtInt(cons.items)} consumables and ${fmtInt(lic.items)} license entries.`,
    table: {
      columns: ['Type', 'Items', 'Total qty/seats', 'Available'],
      rows: [
        ['Accessories', fmtInt(acc.items), fmtInt(acc.total), fmtInt(acc.avail)],
        ['Components', fmtInt(comp.items), fmtInt(comp.total), fmtInt(comp.avail)],
        ['Consumables', fmtInt(cons.items), fmtInt(cons.total), fmtInt(cons.avail)],
        ['Licenses (seat-based)', fmtInt(lic.items), fmtInt(lic.total), fmtInt(lic.avail)]
      ]
    }
  };
}

async function people(q) {
  const u = await db.get(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE status = 'active')::int active,
            COUNT(*) FILTER (WHERE status = 'pending')::int pending
       FROM users WHERE deleted_at IS NULL`);
  const nj = await db.get(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE allocation_status = 'allocated')::int allocated
       FROM new_joinees`);
  return {
    summary: `The directory has ${fmtInt(u.total)} users (${fmtInt(u.active)} active, ${fmtInt(u.pending)} pending). ${fmtInt(nj.total)} new joinees are tracked, ${fmtInt(nj.allocated)} already have onboarding assets allocated.`,
    metrics: [
      { label: 'Total users', value: fmtInt(u.total) },
      { label: 'Active', value: fmtInt(u.active) },
      { label: 'New joinees', value: fmtInt(nj.total) },
      { label: 'Joinees allocated', value: fmtInt(nj.allocated) }
    ]
  };
}

async function priceLookup(q, e) {
  if (!e.software) {
    const rows = await db.query(`SELECT sw_name, unit_price FROM software_prices ORDER BY sw_name`);
    return {
      summary: 'Here are the current unit prices for every software product (editable in License Allocation & Utilization → Software Prices).',
      table: { columns: ['Software', 'Unit price (INR)'], rows: rows.map(r => [r.sw_name, r.unit_price != null ? fmtInr(r.unit_price) : 'Not set']) }
    };
  }
  const row = await db.get(`SELECT unit_price, updated_at::text FROM software_prices WHERE sw_name = $1`, [e.software]);
  if (!row || row.unit_price == null) {
    return { summary: `${e.software} has no unit price set yet — an admin can set it in License Allocation & Utilization → Software Prices.` };
  }
  const rate = await exchangeRateService.getUsdInrRate();
  return {
    summary: `${e.software} costs ${fmtInr(row.unit_price)} per license (about $${Math.round(row.unit_price / rate.rate).toLocaleString('en-US')}).`,
    insights: [`Last updated ${row.updated_at ? row.updated_at.slice(0, 10) : 'at seed time'} · rate 1 USD = ${rate.rate.toFixed(2)} INR (${rate.source}).`]
  };
}

async function softwareDetails(q, e) {
  const params = [e.software];
  const d = await db.get(
    `SELECT SUM(s.qty)::int qty,
            SUM(s.qty) FILTER (WHERE s.allocated_user_id IS NOT NULL)::int allocated,
            COUNT(DISTINCT s.client_name)::int clients,
            COUNT(DISTINCT s.market_name)::int markets,
            MIN(s.renewal_date)::text next_renewal,
            SUM(s.amount)::numeric hist_amount
       FROM software_assets s WHERE s.sw_name = $1`, params);
  const price = await db.get(`SELECT unit_price FROM software_prices WHERE sw_name = $1`, params);
  const topClients = await db.query(
    `SELECT client_name, SUM(qty)::int qty FROM software_assets WHERE sw_name = $1 AND client_name IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, params);
  return {
    summary: `${e.software}: ${fmtInt(d.qty)} licenses (${fmtInt(d.allocated)} allocated) used by ${d.clients} clients across ${d.markets} markets. Next renewal: ${d.next_renewal || 'none scheduled'}.`,
    metrics: [
      { label: 'Licenses', value: fmtInt(d.qty) },
      { label: 'Allocated', value: fmtInt(d.allocated) },
      { label: 'Unit price', value: price && price.unit_price != null ? fmtInr(price.unit_price) : 'Not set' },
      { label: 'Historical spend', value: fmtInr(d.hist_amount) }
    ],
    insights: topClients.length
      ? ['Top clients: ' + topClients.map(c => `${c.client_name} (${fmtInt(c.qty)})`).join(', ') + '.'] : []
  };
}

function help() {
  return {
    summary: 'I answer questions from the live HAMS data — markets, clients, software, licenses, spending, budgets, renewals, hardware, inventory and people.',
    table: {
      columns: ['Try asking', 'What you get'],
      rows: [
        ['How many software products for Athena in HMT2?', 'Counts + license totals for that scope'],
        ['Which market has the highest number of licenses?', 'Ranked comparison across markets'],
        ['Show purchases by GE Healthcare last quarter', 'Purchase records in a period'],
        ['What are our estimated savings?', 'Savings from unused/duplicate licenses'],
        ['Predicted budget for HPR?', 'Next-cycle budget forecast'],
        ['What renews in the next 90 days?', 'Upcoming renewals with value'],
        ['How many laptops are available?', 'Hardware stock by category'],
        ['Price of Director Suite', 'Current unit price in INR/USD']
      ]
    }
  };
}

// ───────────────────────────── Router ─────────────────────────────

// perms: { licenses, assets, personnel, inventory } booleans from the route.
async function answer(question, perms) {
  const raw = String(question || '').trim();
  if (!raw) return help();
  const q = raw.toLowerCase();

  const dict = await entityDictionaries();
  const e = {
    client: findEntity(raw, dict.clients),
    market: findEntity(raw, dict.markets),
    software: findEntity(raw, dict.software),
    range: parseDateRange(q)
  };

  const denied = domain => ({
    summary: `You don't have permission to view ${domain} data. Ask your administrator for access.`,
    denied: true
  });

  try {
    // people / directory
    if (/\b(users?|employees?|joiners?|joinees?|headcount|people|staff)\b/.test(q) && !/software|license/.test(q)) {
      return perms.personnel ? await people(q) : denied('personnel');
    }
    // hardware
    if (/\b(laptops?|hardware|assets?|machines?|devices?)\b/.test(q) && !/software|license/.test(q)) {
      return perms.assets ? await hardware(q, e) : denied('hardware');
    }
    // inventory
    if (/\b(accessor|consumable|component|headphone|inventory|stock)\b/.test(q) && !/software/.test(q)) {
      return perms.inventory ? await inventory(q) : denied('inventory');
    }
    // Everything below reads license/software data.
    if (!perms.licenses) return denied('license and software');

    if (/\b(price|cost per|unit price|how much (is|does))\b/.test(q) && !/spend|budget|total/.test(q)) {
      return priceLookup(q, e);
    }
    if (/renew/.test(q)) return renewals(q, e);
    if (/\b(purchas|bought|buy|acquir|procur)/.test(q)) return purchases(q, e);
    if (/saving|waste|unused cost|reclaim|budget|predict|forecast|spend|cost|revenue|amount/.test(q)
      && !/which (market|client)|highest|most|lowest|least|top\b/.test(q)) {
      return spendingBudget(q, e);
    }
    if (/allocat|utili[sz]ation|assigned licen|unassigned/.test(q)) return allocation(q, e);
    if (/which (market|client)|highest|most|lowest|least|top\b|compare/.test(q)) {
      const dim = /client/.test(q) && !/market/.test(q) ? 'client' : 'market';
      return topGroup(q, e, dim);
    }
    if (e.software && /detail|about|tell me|overview|info/.test(q)) return softwareDetails(q, e);
    if (/how many|count|number of|total/.test(q) || e.client || e.market || e.software) {
      const wantList = /\b(list|show|which|name)\b/.test(q);
      if (e.software && !wantList) return softwareDetails(q, e);
      return countOrListSoftware(q, e, wantList);
    }
    return help();
  } catch (err) {
    return { summary: 'I hit an error answering that: ' + err.message + '. Try rephrasing the question.', error: true };
  }
}

module.exports = { answer };
