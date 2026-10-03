// IT-ASMS CSV adapter for the Import Center.
// Detects the raw "Hardware_Asset_Data (IT-ASMS)" export format and transforms it
// into the assets-module import shape, so users can upload their file as-is.
//
// Handles the format's quirks:
//  - records are CRLF-terminated; cells contain raw UNQUOTED LF newlines
//  - ~5% of rows have unquoted commas (realigned using anchor columns)
//  - dates as dd-MMM-yy, junk/shifted values in any column
const SIGNATURE_COLS = ['Asset Type', 'serial_number', 'FAMS No. / Barcode', 'Machine Name'];

function detect(firstLine) {
  const hits = SIGNATURE_COLS.filter(c => firstLine.includes(c)).length;
  return hits >= 3;
}

// CRLF-only row breaks; any other newline becomes a space inside the field.
function parseCsvCrlf(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += (ch === '\n' || ch === '\r') ? ' ' : ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') {
      i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\n' || ch === '\r') field += ' ';
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

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

const t = v => (v === null || v === undefined) ? '' : String(v).trim();

function parseDate(v) {
  const m = t(v).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return '';
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const mon = months[m[2].toLowerCase()];
  if (!mon) return '';
  let year = parseInt(m[3], 10);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const day = parseInt(m[1], 10);
  if (day < 1 || day > 31 || year < 1990 || year > 2040) return '';
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseAmount(v) {
  const s = t(v).replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return '';
  const n = parseFloat(s);
  return n > 0 && n < 100000000 ? String(n) : '';
}

const JUNK = new Set(['', 'na', 'n/a', '#n/a', 'nil', 'none', 'pending', 'yes', 'no', 'not required',
  'client provided', '0', '-', 'tbd', 'unknown']);
function cleanName(v, max = 100) {
  const s = t(v);
  if (!s || s.length > max) return '';
  if (JUNK.has(s.toLowerCase())) return '';
  if (/^\d+(\.\d+)?$/.test(s)) return '';
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(s)) return '';
  if (!/[A-Za-z]/.test(s)) return '';
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

// Transform raw IT-ASMS text -> { headers, rows, total } in assets-module shape.
function transform(text) {
  const raw = parseCsvCrlf(text.replace(/^﻿/, ''));
  const header = raw[0].map(h => t(h));
  const idx = name => header.indexOf(name);
  const C = {
    sr: idx('Sr.'), assetType: idx('Asset Type'), category: idx('category'), serial: idx('serial_number'),
    po: idx('PO #'), barcode: idx('FAMS No. / Barcode'), purchaseDate: idx('Purchase Date'),
    amount: idx('Amount'), status: idx('status'), user: idx('user'), email: idx('email'),
    workLoc: idx('Work Location'), assetLoc: idx('Asset Location'), manufacturer: idx('Manufacturer'),
    machineName: idx('Machine Name'), model: idx('model_number'), os: idx('OEM OS'),
    cpu: idx('Processor'), cores: idx('No of Cores Processors'), ram: idx('RAM Size'),
    warrantyExpiry: idx('warranty_expiry'), vendor: idx('Vendor Name'), invoice: idx('Invoice No.'),
    order: idx('Order No.'), client: idx('Client'), project: idx('Project'), remarks: idx('Remarks'),
    fixedAssetId: idx('Fixed Asset ID'), insured: idx('Insured')
  };
  const anchors = { status: C.status, warrantyExpiry: C.warrantyExpiry, purchaseDate: C.purchaseDate, assetType: C.assetType };

  const headers = ['asset_tag', 'name', 'serial_number', 'model_number', 'category', 'location',
    'sub_location', 'status', 'purchase_date', 'purchase_cost', 'warranty_expiry', 'user', 'notes',
    'cf_source_row', 'cf_asset_type', 'cf_machine_name', 'cf_processor', 'cf_processor_cores',
    'cf_ram_gb', 'cf_oem_os', 'cf_vendor_name', 'cf_po_number', 'cf_invoice_no', 'cf_order_no',
    'cf_fams_barcode', 'cf_client', 'cf_project', 'cf_assigned_user', 'cf_assigned_email',
    'cf_source_status', 'cf_insured', 'cf_import_source', 'cf_original_serial'];

  const rows = [];
  const seenSerials = new Set();
  const seenTags = new Set();
  let skipped = 0;

  for (let i = 1; i < raw.length; i++) {
    let r = raw[i];
    if (r.length < 10) { skipped++; continue; }
    if (r.length !== header.length) r = realign(r, header.length, anchors);
    const g = j => (j >= 0 && j < r.length) ? t(r[j]) : '';

    let serial = g(C.serial);
    const manufacturer = cleanName(g(C.manufacturer), 60);
    const model = cleanName(g(C.model), 100);
    const barcode = g(C.barcode);
    if (!serial && !(manufacturer && model) && !looksLikeTag(barcode)) { skipped++; continue; }

    // dedupe serials within the batch (same policy as the ETL loader)
    let originalSerial = '';
    if (serial) {
      if (seenSerials.has(serial)) {
        originalSerial = serial;
        let n = 2, cand;
        do { cand = `${serial}-DUP${n++}`; } while (seenSerials.has(cand));
        serial = cand;
      }
      seenSerials.add(serial);
    }

    let category = cleanName(g(C.category), 50);
    if (category && /store|floor|room/i.test(category)) category = '';
    const location = cleanName(g(C.workLoc), 60) || cleanName(g(C.assetLoc), 60);

    const machineName = g(C.machineName);
    let name = looksLikeHostname(machineName) ? machineName
      : (manufacturer && model ? `${manufacturer} ${model}` : (model || (category ? `${category} ${serial || barcode}` : '')));
    if (!name) name = `Asset ${serial || barcode || i}`;

    let tag = '';
    if (looksLikeTag(barcode) && !seenTags.has(barcode)) tag = barcode;
    else if (looksLikeTag(g(C.fixedAssetId)) && !seenTags.has(g(C.fixedAssetId))) tag = g(C.fixedAssetId);
    if (tag) seenTags.add(tag);

    const row = {
      asset_tag: tag,
      name: name.slice(0, 255),
      serial_number: serial,
      model_number: model,
      category,
      location,
      sub_location: '',
      status: /^allocated/i.test(g(C.status)) ? 'assigned' : 'available',
      purchase_date: parseDate(g(C.purchaseDate)),
      purchase_cost: parseAmount(g(C.amount)),
      warranty_expiry: parseDate(g(C.warrantyExpiry)),
      user: '', // people from the export are not created as accounts; kept in cf_ fields
      notes: t(g(C.remarks)).slice(0, 2000),
      cf_source_row: g(C.sr),
      cf_asset_type: g(C.assetType),
      cf_machine_name: machineName,
      cf_processor: g(C.cpu),
      cf_processor_cores: g(C.cores),
      cf_ram_gb: g(C.ram),
      cf_oem_os: g(C.os),
      cf_vendor_name: g(C.vendor),
      cf_po_number: g(C.po),
      cf_invoice_no: g(C.invoice),
      cf_order_no: g(C.order),
      cf_fams_barcode: barcode,
      cf_client: g(C.client),
      cf_project: g(C.project),
      cf_assigned_user: g(C.user),
      cf_assigned_email: g(C.email).includes('@') ? g(C.email) : '',
      cf_source_status: g(C.status),
      cf_insured: g(C.insured),
      cf_import_source: 'IT-ASMS',
      cf_original_serial: originalSerial
    };
    rows.push(row);
  }
  return { headers, rows, total: rows.length, skipped, adapted: true };
}

module.exports = { detect, transform };
