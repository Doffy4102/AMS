// One-off ETL loader: IT-ASMS hardware asset export -> IT-HAMS assets.
// Usage: node tools/import-asms.js "<path-to-csv>"
// - Quote-aware CSV parsing (handles embedded newlines/commas)
// - Defensive field validation (the export contains shifted/malformed rows)
// - Auto-creates categories, locations, manufacturers, asset models
// - Dedupes serials/tags (originals preserved in custom fields)
// - Unmapped source columns land in custom_fields_data (JSON)
const fs = require('fs');
const crypto = require('crypto');
const db = require('../src/core/db');

const FILE = process.argv[2] || 'C:/Users/40211/Downloads/IT_HAM_Data/Hardware_Asset_Data (IT-ASMS)2.csv';

// ---------- CSV parse ----------
// This export terminates records with CRLF only; cells contain raw UNQUOTED LF
// newlines (and quoted CRLFs). So: rows break on CRLF outside quotes; any other
// newline char becomes a space inside the current field.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += (ch === '\n' || ch === '\r') ? ' ' : ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') {
      i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\n' || ch === '\r') field += ' '; // unquoted embedded newline
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rows with >expected fields have unquoted commas in one cell; find the merge
// position that best re-aligns anchor columns (status + warranty dates).
const KNOWN_STATUS = /^(allocated|in repository|retired)/i;
function realign(row, expected, anchors) {
  if (row.length === expected) return row;
  if (row.length < expected) return row.concat(Array(expected - row.length).fill(''));
  const overflow = row.length - expected;
  let best = null, bestScore = -1;
  for (let pos = 0; pos < expected; pos++) {
    const merged = row.slice(0, pos)
      .concat([row.slice(pos, pos + overflow + 1).join(', ')])
      .concat(row.slice(pos + overflow + 1));
    let score = 0;
    if (KNOWN_STATUS.test((merged[anchors.status] || '').trim())) score += 4;
    if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test((merged[anchors.warrantyExpiry] || '').trim())) score += 2;
    if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test((merged[anchors.purchaseDate] || '').trim())) score += 1;
    if ((merged[anchors.assetType] || '').trim().match(/^(Computing|Accessories|Network|Servers)$/i)) score += 2;
    if (score > bestScore) { bestScore = score; best = merged; }
  }
  return best || row.slice(0, expected);
}

// ---------- field validators / normalizers ----------
const t = v => (v === null || v === undefined) ? '' : String(v).trim();

function parseDate(v) { // accepts only dd-MMM-yy(yy)
  const m = t(v).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const mon = months[m[2].toLowerCase()];
  if (!mon) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const day = parseInt(m[1], 10);
  if (day < 1 || day > 31 || year < 1990 || year > 2040) return null;
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseAmount(v) {
  const s = t(v).replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return n > 0 && n < 100000000 ? n : null;
}

const JUNK = new Set(['', 'na', 'n/a', '#n/a', 'nil', 'none', 'pending', 'yes', 'no', 'not required',
  'client provided', 'client  provided', '0', '-', 'tbd', 'unknown']);
function cleanName(v, max = 100) {
  const s = t(v);
  if (!s || s.length > max) return null;
  if (JUNK.has(s.toLowerCase())) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return null;                       // pure number
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(s)) return null;       // a date
  if (!/[A-Za-z]/.test(s)) return null;                           // must contain letters
  return s;
}

function looksLikeTag(v) {
  const s = t(v);
  return /^\d{6,12}$/.test(s) || /^[A-Z]{2,6}[-_]?\d{3,}$/i.test(s);
}

function looksLikeHostname(v) {
  const s = t(v);
  return /^[A-Za-z][A-Za-z0-9\-_.]{2,30}$/.test(s) && !/stock|return|client|store/i.test(s);
}

// ---------- main ----------
(async () => {
  console.log('Reading', FILE);
  const text = fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(text);
  const header = rows[0].map(h => t(h));
  const col = name => header.indexOf(name);
  const C = {
    sr: col('Sr.'), assetType: col('Asset Type'), category: col('category'), serial: col('serial_number'),
    po: col('PO #'), barcode: col('FAMS No. / Barcode'), purchaseDate: col('Purchase Date'),
    amount: col('Amount'), status: col('status'), allocType: col('Type of Allocation'), ctid: col('CTID'),
    user: col('user'), email: col('email'), workLoc: col('Work Location'), assetAge: col('Asset Age'),
    clientProvided: col('Client Provided Asset'), dutyExempted: col('Duty Exempted'), assetLoc: col('Asset Location'),
    ctidEmployer: col('CTID Employer Name'), parentType: col('Parent Asset Type'), manufacturer: col('Manufacturer'),
    machineName: col('Machine Name'), model: col('model_number'), os: col('OEM OS'), hddType: col('Harddisk Type'),
    hddSize: col('Harddisk Size'), hddCount: col('No of Harddisks'), cpu: col('Processor'),
    cores: col('No of Cores Processors'), ram: col('RAM Size'), warrantyStart: col('Warranty Start Date'),
    warrantyExpiry: col('warranty_expiry'), warrantyDays: col('Remaining Warranty In Days'), vendor: col('Vendor Name'),
    invoice: col('Invoice No.'), order: col('Order No.'), baseline: col('Baseline Date'), keyboard: col('Keyboard'),
    monitor: col('Monitor'), client: col('Client'), group: col('Group'), project: col('Project'),
    remarks: col('Remarks'), fixedAssetId: col('Fixed Asset ID'), grn: col('GRN No.'), insured: col('Insured')
  };

  // ---- Pass 1: filter + normalize ----
  const assets = [];
  let skipped = 0;
  const categories = new Set(), locations = new Set(), manufacturers = new Set(), models = new Map();

  const anchors = { status: C.status, warrantyExpiry: C.warrantyExpiry, purchaseDate: C.purchaseDate, assetType: C.assetType };
  let realigned = 0;
  for (let i = 1; i < rows.length; i++) {
    let r = rows[i];
    if (r.length < 10) { skipped++; continue; }
    if (r.length !== header.length) { r = realign(r, header.length, anchors); realigned++; }
    const g = idx => (idx >= 0 && idx < r.length) ? t(r[idx]) : '';

    const serial = g(C.serial);
    const manufacturer = cleanName(g(C.manufacturer), 60);
    const model = cleanName(g(C.model), 100);
    const barcode = g(C.barcode);
    // Keep only rows that identify a real asset
    if (!serial && !(manufacturer && model) && !looksLikeTag(barcode)) { skipped++; continue; }

    let category = cleanName(g(C.category), 50);
    if (category && /store|floor|room/i.test(category)) category = null; // shifted location values
    const location = cleanName(g(C.workLoc), 60) || cleanName(g(C.assetLoc), 60);

    const rawStatus = g(C.status).toLowerCase();
    let status = 'available', label = 'In Stock';
    if (rawStatus.startsWith('allocated')) { status = 'assigned'; label = 'Deployed'; }
    else if (rawStatus.startsWith('retired')) { status = 'archived'; label = 'Retired'; }

    const machineName = g(C.machineName);
    let name = looksLikeHostname(machineName) ? machineName
      : (manufacturer && model ? `${manufacturer} ${model}` : (model || (category ? `${category} ${serial || barcode}` : null)));
    if (!name) name = `Asset ${serial || barcode || i}`;
    name = name.slice(0, 255);

    // custom fields: everything not first-class, only non-empty
    const cf = {};
    const put = (k, v) => { const s = t(v); if (s && s.length <= 300) cf[k] = s; };
    put('source_row', g(C.sr));
    put('asset_type', g(C.assetType));
    put('parent_asset_type', g(C.parentType));
    put('machine_name', machineName);
    put('processor', g(C.cpu));
    put('processor_cores', g(C.cores));
    put('ram_gb', g(C.ram));
    put('oem_os', g(C.os));
    put('harddisk_type', g(C.hddType));
    put('harddisk_size', g(C.hddSize));
    put('harddisk_count', g(C.hddCount));
    const ws = parseDate(g(C.warrantyStart)); if (ws) cf.warranty_start = ws;
    put('remaining_warranty_days', /^\d+$/.test(g(C.warrantyDays)) ? g(C.warrantyDays) : '');
    put('vendor_name', g(C.vendor));
    put('po_number', g(C.po));
    put('invoice_no', g(C.invoice));
    put('order_no', g(C.order));
    put('grn_no', g(C.grn));
    put('fams_barcode', barcode);
    put('fixed_asset_id', g(C.fixedAssetId));
    put('client', g(C.client));
    put('project', g(C.project));
    put('business_group', g(C.group));
    put('assigned_user', g(C.user));
    if (g(C.email).includes('@')) cf.assigned_email = g(C.email);
    put('ctid', g(C.ctid));
    put('ctid_employer', g(C.ctidEmployer));
    put('type_of_allocation', g(C.allocType));
    put('client_provided', g(C.clientProvided));
    put('duty_exempted', g(C.dutyExempted));
    put('insured', g(C.insured));
    put('asset_age', g(C.assetAge));
    put('keyboard', g(C.keyboard));
    put('monitor', g(C.monitor));
    const bl = parseDate(g(C.baseline)); if (bl) cf.baseline_date = bl;
    put('source_status', g(C.status));
    cf.import_source = 'IT-ASMS';

    if (category) categories.add(category);
    if (location) locations.add(location);
    if (manufacturer) manufacturers.add(manufacturer);
    if (manufacturer && model) models.set(`${manufacturer}||${model}`, { manufacturer, model });

    assets.push({
      serial: serial || null, barcode, category, location, manufacturer, model, name,
      status, label,
      purchase_date: parseDate(g(C.purchaseDate)),
      purchase_cost: parseAmount(g(C.amount)),
      warranty_expiry: parseDate(g(C.warrantyExpiry)),
      notes: t(g(C.remarks)).slice(0, 2000) || null,
      cf
    });
  }
  console.log(`Parsed ${rows.length - 1} records -> ${assets.length} assets, ${skipped} junk rows skipped, ${realigned} rows realigned`);
  console.log(`Catalog: ${categories.size} categories, ${locations.size} locations, ${manufacturers.size} manufacturers, ${models.size} models`);

  // ---- Pass 2: catalog entities ----
  const catColors = ['#3b82f6', '#6366f1', '#06b6d4', '#8b5cf6', '#14b8a6', '#f59e0b', '#64748b', '#22c55e', '#f97316', '#ec4899'];
  let ci = 0;
  for (const c of categories) {
    await db.run(`INSERT INTO asset_categories (name, type, color) VALUES ($1, 'asset', $2) ON CONFLICT (name) DO NOTHING`,
      [c, catColors[ci++ % catColors.length]]);
  }
  for (const l of locations) {
    await db.run(`INSERT INTO locations (name, country) VALUES ($1, $2)
                  ON CONFLICT DO NOTHING`, [l, /usa|us$|canada/i.test(l) ? (/canada/i.test(l) ? 'Canada' : 'USA') : 'India']);
  }
  for (const m of manufacturers) {
    await db.run(`INSERT INTO manufacturers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [m]);
  }
  await db.run(`INSERT INTO status_labels (name, type, color) VALUES ('Retired', 'archived', '#71717a') ON CONFLICT (name) DO NOTHING`);

  const catMap = new Map((await db.query('SELECT id, name FROM asset_categories')).map(r => [r.name, r.id]));
  const locMap = new Map((await db.query('SELECT id, name FROM locations')).map(r => [r.name, r.id]));
  const mfMap = new Map((await db.query('SELECT id, name FROM manufacturers')).map(r => [r.name, r.id]));
  const labelMap = new Map((await db.query('SELECT id, name FROM status_labels')).map(r => [r.name, r.id]));

  for (const { manufacturer, model } of models.values()) {
    await db.run(`INSERT INTO asset_models (name, model_number, manufacturer_id)
                  VALUES ($1, $1, $2) ON CONFLICT (name, model_number) DO NOTHING`, [model, mfMap.get(manufacturer)]);
  }
  const modelRows = await db.query('SELECT id, name, manufacturer_id FROM asset_models');
  const modelMap = new Map(modelRows.map(r => [`${r.manufacturer_id}||${r.name}`, r.id]));

  // ---- Pass 3: dedupe serials/tags against DB + within batch ----
  const usedSerials = new Set((await db.query('SELECT serial_number FROM assets WHERE serial_number IS NOT NULL')).map(r => r.serial_number));
  const usedTags = new Set((await db.query('SELECT asset_tag FROM assets WHERE asset_tag IS NOT NULL')).map(r => r.asset_tag));
  let tagSeq = 1, synSeq = 1, dupSerials = 0, synSerials = 0;
  const nextTag = () => { let s; do { s = 'ASMS-' + String(tagSeq++).padStart(6, '0'); } while (usedTags.has(s)); return s; };

  for (const a of assets) {
    // serial
    if (a.serial) {
      if (usedSerials.has(a.serial)) {
        a.cf.original_serial = a.serial;
        let n = 2, cand;
        do { cand = `${a.serial}-DUP${n++}`; } while (usedSerials.has(cand));
        a.serial = cand; dupSerials++;
      }
      usedSerials.add(a.serial);
    } else {
      a.serial = `SYN-${String(synSeq++).padStart(6, '0')}`;
      while (usedSerials.has(a.serial)) a.serial = `SYN-${String(synSeq++).padStart(6, '0')}`;
      usedSerials.add(a.serial);
      a.cf.serial_synthetic = 'true';
      synSerials++;
    }
    // tag
    let tag = null;
    if (looksLikeTag(a.barcode) && !usedTags.has(a.barcode)) tag = a.barcode;
    else if (looksLikeTag(a.cf.fixed_asset_id || '') && !usedTags.has(a.cf.fixed_asset_id)) tag = a.cf.fixed_asset_id;
    if (!tag) tag = nextTag();
    usedTags.add(tag);
    a.tag = tag;
  }
  console.log(`Serials: ${dupSerials} duplicates suffixed, ${synSerials} synthesized`);

  // ---- Pass 4: batched inserts ----
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < assets.length; i += BATCH) {
    const batch = assets.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;
    for (const a of batch) {
      const mfId = a.manufacturer ? mfMap.get(a.manufacturer) : null;
      const modelId = (mfId && a.model) ? (modelMap.get(`${mfId}||${a.model}`) || null) : null;
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        a.tag, crypto.randomBytes(16).toString('hex'), a.name, modelId,
        a.category ? catMap.get(a.category) : null, mfId,
        a.location ? locMap.get(a.location) : null,
        a.serial, a.model || null, a.category || null, a.status,
        labelMap.get(a.label) || null,
        a.purchase_date, a.purchase_cost, a.warranty_expiry === null ? null : a.warranty_expiry,
        JSON.stringify(a.cf)
      );
      // notes added below via update? no — include in insert: adjust columns
    }
    const res = await db.pool.query(
      `INSERT INTO assets (asset_tag, label_token, name, asset_model_id, category_id, manufacturer_id,
         location_id, serial_number, model_number, category, status, status_label_id,
         purchase_date, purchase_cost, warranty_expiry, custom_fields_data)
       VALUES ${values.join(',')} RETURNING id`, params);
    // notes (second pass batched update only where present)
    const withNotes = batch.map((a, k) => ({ id: res.rows[k].id, notes: a.notes })).filter(x => x.notes);
    if (withNotes.length) {
      const np = [];
      const cases = withNotes.map((x, k) => { np.push(x.id, x.notes); return `WHEN id = $${k * 2 + 1} THEN $${k * 2 + 2}`; });
      await db.pool.query(
        `UPDATE assets SET notes = CASE ${cases.join(' ')} END WHERE id IN (${withNotes.map((_, k) => `$${k * 2 + 1}`).join(',')})`, np);
    }
    // stock_in ledger movements
    const mv = [];
    const mp = [];
    let q = 1;
    batch.forEach((a, k) => {
      mv.push(`($${q++},$${q++},$${q++},$${q++})`);
      mp.push(res.rows[k].id, a.location ? locMap.get(a.location) : null,
        a.status === 'assigned' ? 'assigned' : 'available', 'IT-ASMS bulk import');
    });
    await db.pool.query(
      `INSERT INTO stock_movements (module_key, item_id, movement_type, direction, quantity, to_location_id, effective_status, reason)
       SELECT 'assets', v.id, 'stock_in', 'in', 1, v.loc, v.st, v.reason
       FROM (VALUES ${batch.map((_, k) => `($${k * 4 + 1}::int, $${k * 4 + 2}::int, $${k * 4 + 3}, $${k * 4 + 4})`).join(',')}) AS v(id, loc, st, reason)`,
      mp);
    inserted += batch.length;
    if (inserted % 2000 === 0 || inserted === assets.length) console.log(`  inserted ${inserted}/${assets.length}`);
  }

  await db.run(`INSERT INTO import_jobs (type, status, rows_total, rows_imported, errors, created_by)
                VALUES ('assets', 'completed', $1, $2, $3, 1)`,
    [rows.length - 1, inserted, `IT-ASMS ETL: ${skipped} junk rows skipped, ${dupSerials} dup serials suffixed, ${synSerials} serials synthesized`]);
  await db.run(`INSERT INTO activity_logs (user_id, action, description) VALUES (1, 'ASSET_BULK_IMPORTED', $1)`,
    [`IT-ASMS import: ${inserted} assets loaded from Hardware_Asset_Data (IT-ASMS)2.csv`]);

  console.log(`\nDONE: ${inserted} assets imported.`);
  process.exit(0);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
