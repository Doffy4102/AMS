// Port of ImportExportService: module-config driven CSV import + filtered exports.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../core/db');
const ledger = require('./movementLedgerService');
const customFields = require('./customFieldService');
const { HttpError, trimStr, intOr } = require('../core/helpers');

// Column tuple: [db_column, label, type, required, fk_table|null]
const MODULES = {
  assets: {
    label: 'Hardware Assets', table: 'assets', icon: 'laptop',
    columns: [
      ['asset_tag', 'Asset Tag', 'string', false, null],
      ['name', 'Name', 'string', true, null],
      ['serial_number', 'Serial Number', 'string', false, null],
      ['model_number', 'Model Number', 'string', false, null],
      ['category', 'Category (Name)', 'string', false, 'asset_categories'],
      ['location', 'Location (Name)', 'string', false, 'locations'],
      ['sub_location', 'Sub-Location (Name)', 'string', false, 'sub_locations'],
      ['status', 'Status', 'string', false, null],
      ['purchase_date', 'Purchase Date', 'date', false, null],
      ['purchase_cost', 'Purchase Cost', 'decimal', false, null],
      ['warranty_expiry', 'Warranty Expiry', 'date', false, null],
      ['user', 'Assigned User', 'string', false, 'users'],
      ['notes', 'Notes', 'string', false, null]
    ]
  },
  users: {
    label: 'Users', table: 'users', icon: 'users',
    columns: [
      ['employee_id', 'Employee ID', 'string', false, null],
      ['name', 'Full Name', 'string', true, null],
      ['email', 'Email', 'string', true, null],
      ['role', 'Role', 'string', false, null],
      ['status', 'Status', 'string', false, null]
    ]
  },
  accessories: {
    label: 'Accessories', table: 'accessories', icon: 'mouse',
    columns: [
      ['name', 'Name', 'string', true, null],
      ['model_number', 'Model Number', 'string', false, null],
      ['serial_number', 'Serial Number', 'string', false, null],
      ['category', 'Category (Name)', 'string', false, 'asset_categories'],
      ['manufacturer', 'Manufacturer (Name)', 'string', false, 'manufacturers'],
      ['location', 'Location (Name)', 'string', false, 'locations'],
      ['sub_location', 'Sub-Location (Name)', 'string', false, 'sub_locations'],
      ['total_qty', 'Total Qty', 'int', false, null],
      ['assigned_qty', 'Assigned Qty', 'int', false, null],
      ['user', 'Assigned User', 'string', false, 'users'],
      ['min_qty', 'Min Qty', 'int', false, null],
      ['notes', 'Notes', 'string', false, null]
    ]
  },
  consumables: {
    label: 'Consumables', table: 'consumables', icon: 'package-minus',
    columns: [
      ['name', 'Name', 'string', true, null],
      ['category', 'Category (Name)', 'string', false, 'asset_categories'],
      ['manufacturer', 'Manufacturer (Name)', 'string', false, 'manufacturers'],
      ['location', 'Location (Name)', 'string', false, 'locations'],
      ['sub_location', 'Sub-Location (Name)', 'string', false, 'sub_locations'],
      ['total_qty', 'Total Qty', 'int', false, null],
      ['assigned_qty', 'Issued Qty', 'int', false, null],
      ['user', 'Issued User', 'string', false, 'users'],
      ['min_qty', 'Min Qty', 'int', false, null],
      ['notes', 'Notes', 'string', false, null]
    ]
  },
  components: {
    label: 'Components', table: 'components', icon: 'cpu',
    columns: [
      ['name', 'Name', 'string', true, null],
      ['serial_number', 'Serial Number', 'string', false, null],
      ['category', 'Category (Name)', 'string', false, 'asset_categories'],
      ['manufacturer', 'Manufacturer (Name)', 'string', false, 'manufacturers'],
      ['location', 'Location (Name)', 'string', false, 'locations'],
      ['sub_location', 'Sub-Location (Name)', 'string', false, 'sub_locations'],
      ['total_qty', 'Total Qty', 'int', false, null],
      ['assigned_qty', 'Installed Qty', 'int', false, null],
      ['user', 'Assigned User', 'string', false, 'users'],
      ['min_qty', 'Min Qty', 'int', false, null],
      ['notes', 'Notes', 'string', false, null]
    ]
  },
  licenses: {
    label: 'Licenses', table: 'licenses', icon: 'key-round',
    columns: [
      ['name', 'Name', 'string', true, null],
      ['manufacturer', 'Manufacturer (Name)', 'string', false, 'manufacturers'],
      ['location', 'Location (Name)', 'string', false, 'locations'],
      ['sub_location', 'Sub-Location (Name)', 'string', false, 'sub_locations'],
      ['seats', 'Seats', 'int', false, null],
      ['license_key', 'License Key', 'string', false, null],
      ['expiration_date', 'Expiration Date', 'date', false, null],
      ['user', 'Assigned User', 'string', false, 'users'],
      ['notes', 'Notes', 'string', false, null]
    ]
  },
  locations: {
    label: 'Locations', table: 'locations', icon: 'map-pin',
    columns: [
      ['name', 'Name', 'string', true, null],
      ['address', 'Address', 'string', false, null],
      ['city', 'City', 'string', false, null],
      ['country', 'Country', 'string', false, null]
    ]
  },
  sub_locations: {
    label: 'Sub-Locations', table: 'sub_locations', icon: 'map-pin',
    columns: [
      ['location', 'Parent Location', 'string', true, 'locations'],
      ['name', 'Name', 'string', true, null],
      ['code', 'Code', 'string', false, null],
      ['floor', 'Floor', 'string', false, null],
      ['room', 'Room', 'string', false, null],
      ['notes', 'Notes', 'string', false, null]
    ]
  },
  audit_logs: {
    label: 'Audit Logs', table: 'activity_logs', icon: 'shield',
    columns: [
      ['created_at', 'Created At', 'datetime', false, null],
      ['action', 'Action', 'string', false, null],
      ['description', 'Description', 'string', false, null],
      ['user', 'User', 'string', false, 'users']
    ]
  }
};

const CF_MODULES = ['assets', 'accessories', 'consumables', 'components', 'licenses'];

function getModuleConfig(module) { return MODULES[module] || null; }

async function getColumnsWithCustomFields(module) {
  const config = getModuleConfig(module);
  if (!config) return [];
  const columns = [...config.columns];
  if (CF_MODULES.includes(module)) {
    const fields = await customFields.getFieldsByModule(module, null);
    for (const f of Object.values(fields)) {
      columns.push(['cf_' + f.field_key, 'CF: ' + f.name, f.field_type, !!f.is_required, null]);
    }
  }
  return columns;
}

async function countModuleRows(module) {
  const config = getModuleConfig(module);
  if (!config) return 0;
  const softDeleted = ['assets', 'users', 'accessories', 'consumables', 'components', 'licenses', 'sub_locations'];
  const where = softDeleted.includes(module) ? 'WHERE deleted_at IS NULL' : '';
  const row = await db.get(`SELECT COUNT(*)::int AS c FROM ${config.table} ${where}`);
  return row.c;
}

async function getModules() {
  const out = [];
  for (const [key, config] of Object.entries(MODULES)) {
    const columns = await getColumnsWithCustomFields(key);
    out.push({
      key, label: config.label, icon: config.icon,
      count: await countModuleRows(key),
      columns: columns.map(c => c[1])
    });
  }
  return out;
}

// ---- CSV parsing ----
function parseCsvLine(line, delimiter) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseUpload(fileContent, pastedCsv) {
  const raw = (fileContent && fileContent.trim()) ? fileContent : (pastedCsv || '');
  if (!raw.trim()) throw new HttpError('No CSV data provided. Upload a file or paste CSV content.', 422);
  const lines = raw.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new HttpError('CSV must include a header row and at least one data row.', 422);
  const header = lines[0];
  const delimiter = (header.split('\t').length - 1) > (header.split(',').length - 1) ? '\t' : ',';
  const headers = parseCsvLine(header, delimiter).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i], delimiter);
    if (cols.length !== headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx].trim(); });
    rows.push(row);
  }
  return { headers, rows, total: rows.length };
}

// ---- Row validation ----
async function existsIn(table, col, val, excludeDeleted = true) {
  const allowedTables = ['assets', 'users', 'accessories', 'components'];
  const allowedCols = ['asset_tag', 'serial_number', 'email'];
  if (!allowedTables.includes(table) || !allowedCols.includes(col)) return false;
  const where = excludeDeleted ? 'AND deleted_at IS NULL' : '';
  const row = await db.get(`SELECT id FROM ${table} WHERE ${col} = $1 ${where} LIMIT 1`, [val]);
  return !!row;
}

async function resolveUserId(token) {
  const t = trimStr(token);
  if (!t) return null;
  if (t.includes('@')) {
    const u = await db.get('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [t]);
    if (!u) throw new HttpError(`User not found for email: ${t}`, 422);
    return u.id;
  }
  const byEmp = await db.get('SELECT id FROM users WHERE employee_id = $1 AND deleted_at IS NULL', [t]);
  if (byEmp) return byEmp.id;
  const byName = await db.query('SELECT id FROM users WHERE name = $1 AND deleted_at IS NULL', [t]);
  if (byName.length > 1) throw new HttpError(`Multiple users found for name: ${t}. Use email or employee_id.`, 422);
  if (byName.length === 0) throw new HttpError(`User not found: ${t}`, 422);
  return byName[0].id;
}

async function validateRows(module, rows) {
  const columns = await getColumnsWithCustomFields(module);
  const valid = [];
  const errors = [];
  const seenTags = new Set(), seenSerials = new Set(), seenEmails = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 2;
    const rowErrors = [];

    for (const [key, lbl, type, required] of columns) {
      const val = trimStr(row[key]);
      if (required && !val) { rowErrors.push(`Missing required field: ${key}`); continue; }
      if (!val) continue;
      if (type === 'date' || type === 'datetime') {
        if (Number.isNaN(new Date(val).getTime())) rowErrors.push(`Invalid date in '${lbl}': ${val}`);
      } else if (type === 'int') {
        if (!/^-?\d+$/.test(val)) rowErrors.push(`Invalid integer in '${lbl}': ${val}`);
      } else if (type === 'decimal' || type === 'number') {
        if (Number.isNaN(Number(val))) rowErrors.push(`Invalid number in '${lbl}': ${val}`);
      } else if (type === 'boolean') {
        if (!['1', '0', 'true', 'false', 'yes', 'no'].includes(val.toLowerCase())) {
          rowErrors.push(`Invalid boolean in '${lbl}': ${val}. Use 1/0, true/false, or yes/no.`);
        }
      }
    }

    if (module === 'assets') {
      const tag = trimStr(row.asset_tag).toLowerCase();
      if (tag && (seenTags.has(tag) || await existsIn('assets', 'asset_tag', trimStr(row.asset_tag)))) {
        rowErrors.push(`Duplicate asset_tag: ${row.asset_tag}`);
      }
      if (tag) seenTags.add(tag);
      const serial = trimStr(row.serial_number).toLowerCase();
      if (serial && (seenSerials.has(serial) || await existsIn('assets', 'serial_number', trimStr(row.serial_number)))) {
        rowErrors.push(`Duplicate serial_number: ${row.serial_number}`);
      }
      if (serial) seenSerials.add(serial);
    } else if (module === 'users') {
      const email = trimStr(row.email);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) rowErrors.push(`Invalid email: ${email}`);
      const key = email.toLowerCase();
      if (key && (seenEmails.has(key) || await existsIn('users', 'email', email))) {
        rowErrors.push(`Duplicate email: ${email}`);
      }
      if (key) seenEmails.add(key);
    } else if (module === 'accessories' || module === 'components') {
      const serial = trimStr(row.serial_number).toLowerCase();
      if (serial && (seenSerials.has(serial) || await existsIn(module, 'serial_number', trimStr(row.serial_number)))) {
        rowErrors.push(`Duplicate serial_number: ${row.serial_number}`);
      }
      if (serial) seenSerials.add(serial);
    }

    if (CF_MODULES.includes(module) && trimStr(row.user)) {
      try { await resolveUserId(row.user); } catch (err) { rowErrors.push(err.message); }
    }

    if (rowErrors.length) errors.push({ line, data: row, errors: rowErrors });
    else valid.push(row);
  }
  return { valid, errors, valid_count: valid.length, error_count: errors.length };
}

// ---- Insert handlers ----
async function resolveFk(t, table, name) {
  const n = trimStr(name);
  if (!n) return null;
  const row = await t.get(`SELECT id FROM ${table} WHERE name = $1 LIMIT 1`, [n]);
  return row ? row.id : null;
}

async function resolveSubLocationFk(t, locName, subName) {
  const n = trimStr(subName);
  if (!n) return null;
  const parent = trimStr(locName);
  if (parent) {
    const row = await t.get(
      `SELECT sl.id FROM sub_locations sl JOIN locations l ON sl.location_id = l.id
       WHERE sl.name = $1 AND l.name = $2 AND sl.deleted_at IS NULL LIMIT 1`, [n, parent]);
    if (row) return row.id;
  }
  const row = await t.get('SELECT id FROM sub_locations WHERE name = $1 AND deleted_at IS NULL LIMIT 1', [n]);
  return row ? row.id : null;
}

function extractCf(row) {
  const cf = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('cf_')) cf[k.substring(3)] = v;
  }
  return JSON.stringify(cf);
}

function nullOrDate(v) {
  const s = trimStr(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function insertAsset(t, row) {
  const serial = trimStr(row.serial_number) || null;
  if (serial) {
    const dup = await t.get('SELECT id FROM assets WHERE serial_number = $1 AND deleted_at IS NULL', [serial]);
    if (dup) throw new HttpError(`Duplicate serial_number: ${serial}`, 422);
  }
  const categoryId = await resolveFk(t, 'asset_categories', row.category);
  const subLocationId = await resolveSubLocationFk(t, row.location, row.sub_location);
  const stockLabel = await t.get(`SELECT id FROM status_labels WHERE name IN ('In Stock', 'Ready to Deploy') ORDER BY CASE name WHEN 'In Stock' THEN 0 ELSE 1 END LIMIT 1`);
  const userId = await resolveUserId(row.user);
  let status = 'available';
  let labelId = stockLabel ? stockLabel.id : null;
  if (userId) {
    status = 'assigned';
    const deployed = await t.get(`SELECT id FROM status_labels WHERE name IN ('Deployed', 'Assigned') ORDER BY CASE name WHEN 'Deployed' THEN 0 ELSE 1 END LIMIT 1`);
    labelId = deployed ? deployed.id : labelId;
  }
  const labelToken = crypto.randomBytes(16).toString('hex');
  const locationId = await resolveFk(t, 'locations', row.location);
  const assetId = await t.insert(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category_id, category,
       location_id, status, status_label_id, assigned_to, purchase_date, purchase_cost, warranty_expiry,
       notes, sub_location_id, custom_fields_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [trimStr(row.asset_tag) || null, labelToken, trimStr(row.name), serial, trimStr(row.model_number) || null,
      categoryId, trimStr(row.category) || null, locationId, status, labelId, userId,
      nullOrDate(row.purchase_date),
      trimStr(row.purchase_cost) !== '' ? Number(row.purchase_cost) : null,
      nullOrDate(row.warranty_expiry), trimStr(row.notes) || null, subLocationId, extractCf(row)]);
  await ledger.record({
    module_key: 'assets', item_id: assetId, movement_type: 'stock_in', direction: 'in', quantity: 1,
    to_location_id: locationId, effective_status: 'available', reason: 'Bulk asset import'
  }, t);
  if (userId) {
    const assignmentId = await t.insert(
      `INSERT INTO assignments (asset_id, user_id, checkout_notes) VALUES ($1, $2, 'Assigned during bulk asset import.')`,
      [assetId, userId]);
    await ledger.record({
      module_key: 'assets', item_id: assetId, movement_type: 'assigned', direction: 'out', quantity: 1,
      holder_user_id: userId, related_assignment_id: assignmentId, effective_status: 'assigned',
      reason: 'Bulk asset import'
    }, t);
  }
}

async function insertUser(t, row) {
  const email = trimStr(row.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(`Invalid email: ${email}`, 422);
  const dup = await t.get('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (dup) throw new HttpError(`Duplicate email: ${email}`, 422);
  const password = await bcrypt.hash('changeme123', 10);
  await t.insert(
    'INSERT INTO users (employee_id, name, email, password, role, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [trimStr(row.employee_id) || null, trimStr(row.name), email, password,
      trimStr(row.role) || 'user', trimStr(row.status) || 'active']);
}

function assignedQty(row, qty) {
  const raw = intOr(row.assigned_qty, 1);
  const q = Math.max(1, raw);
  if (qty <= 0) throw new HttpError('total_qty must be greater than 0 when user is provided.', 422);
  if (q > qty) throw new HttpError(`Assigned quantity (${q}) cannot exceed total quantity (${qty}).`, 422);
  return q;
}

async function assignedAssetIdForUser(t, userId) {
  const rows = await t.query('SELECT id FROM assets WHERE assigned_to = $1 AND deleted_at IS NULL', [userId]);
  if (rows.length > 1) throw new HttpError('Component import user has multiple assigned hardware assets. Assign components manually.', 422);
  if (rows.length === 0) throw new HttpError('Component import user has no assigned hardware asset.', 422);
  return rows[0].id;
}

async function insertInventoryItem(t, table, availCol, row) {
  const categoryId = await resolveFk(t, 'asset_categories', row.category);
  const manufacturerId = await resolveFk(t, 'manufacturers', row.manufacturer);
  const subLocationId = await resolveSubLocationFk(t, row.location, row.sub_location);
  let locationId = null;
  if (subLocationId) {
    const parent = await t.get('SELECT location_id FROM sub_locations WHERE id = $1', [subLocationId]);
    locationId = parent ? parent.location_id : null;
  }
  if (!locationId) locationId = await resolveFk(t, 'locations', row.location);

  const qty = Math.max(0, intOr(row.total_qty, 0));
  const userId = await resolveUserId(row.user);
  const aQty = userId ? assignedQty(row, qty) : 0;
  const available = Math.max(0, qty - aQty);
  const minQty = Math.max(0, intOr(row.min_qty, 0));

  const serial = trimStr(row.serial_number);
  if ((table === 'accessories' || table === 'components') && serial) {
    const dup = await t.get(`SELECT id FROM ${table} WHERE serial_number = $1 AND deleted_at IS NULL`, [serial]);
    if (dup) throw new HttpError(`Duplicate serial_number in ${table}: ${serial}`, 422);
  }

  const cols = ['name', 'category_id', 'manufacturer_id', 'location_id', 'sub_location_id', 'total_qty', availCol, 'min_qty', 'notes', 'custom_fields_data'];
  const vals = [trimStr(row.name), categoryId, manufacturerId, locationId, subLocationId, qty, available, minQty, trimStr(row.notes) || null, extractCf(row)];
  if (table === 'accessories' && trimStr(row.model_number)) { cols.push('model_number'); vals.push(trimStr(row.model_number)); }
  if ((table === 'accessories' || table === 'components') && serial) { cols.push('serial_number'); vals.push(serial); }

  const itemId = await t.insert(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);

  if (qty > 0) {
    await ledger.record({
      module_key: table, item_id: itemId, movement_type: 'stock_in', direction: 'in', quantity: qty,
      to_location_id: locationId, effective_status: 'available', reason: `Bulk ${table} import`
    }, t);
  }
  if (userId && aQty > 0) {
    const singular = table.replace(/s$/, '');
    const notes = `Assigned during bulk ${singular} import.`;
    if (table === 'accessories') {
      await t.run('INSERT INTO accessory_assignments (accessory_id, user_id, qty, notes) VALUES ($1,$2,$3,$4)', [itemId, userId, aQty, notes]);
    } else if (table === 'consumables') {
      await t.run('INSERT INTO consumable_issues (consumable_id, user_id, qty, notes) VALUES ($1,$2,$3,$4)', [itemId, userId, aQty, notes]);
    } else if (table === 'components') {
      const assetId = await assignedAssetIdForUser(t, userId);
      await t.run('INSERT INTO component_assignments (component_id, asset_id, qty, notes) VALUES ($1,$2,$3,$4)', [itemId, assetId, aQty, notes]);
    }
    await ledger.record({
      module_key: table, item_id: itemId,
      movement_type: table === 'consumables' ? 'issued' : 'assigned',
      direction: 'out', quantity: aQty, holder_user_id: userId,
      effective_status: 'assigned', reason: `Bulk ${table} import`
    }, t);
  }
}

async function insertLicense(t, row) {
  const manufacturerId = await resolveFk(t, 'manufacturers', row.manufacturer);
  const subLocationId = await resolveSubLocationFk(t, row.location, row.sub_location);
  const locationId = await resolveFk(t, 'locations', row.location);
  const seats = Math.max(1, intOr(row.seats, 1));
  const userId = await resolveUserId(row.user);
  const assignedSeats = userId ? 1 : 0;
  const itemId = await t.insert(
    `INSERT INTO licenses (name, manufacturer_id, location_id, sub_location_id, seats, available_seats,
       license_key, expiration_date, notes, custom_fields_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [trimStr(row.name), manufacturerId, locationId, subLocationId, seats, Math.max(0, seats - assignedSeats),
      trimStr(row.license_key) || null, nullOrDate(row.expiration_date), trimStr(row.notes) || null, extractCf(row)]);
  if (userId) {
    await t.run(`INSERT INTO license_assignments (license_id, user_id, notes) VALUES ($1, $2, 'Assigned during bulk license import.')`,
      [itemId, userId]);
  }
}

async function insertLocation(t, row) {
  await t.insert('INSERT INTO locations (name, address, city, country) VALUES ($1,$2,$3,$4)',
    [trimStr(row.name), trimStr(row.address) || null, trimStr(row.city) || null, trimStr(row.country) || null]);
}

async function insertSubLocation(t, row) {
  const parentId = await resolveFk(t, 'locations', row.location);
  if (!parentId) throw new HttpError(`Parent location not found: ${row.location}`, 422);
  await t.insert('INSERT INTO sub_locations (location_id, name, code, floor, room, notes) VALUES ($1,$2,$3,$4,$5,$6)',
    [parentId, trimStr(row.name), trimStr(row.code) || null, trimStr(row.floor) || null, trimStr(row.room) || null, trimStr(row.notes) || null]);
}

async function insertRow(module, row) {
  await db.tx(async t => {
    switch (module) {
      case 'assets': return insertAsset(t, row);
      case 'users': return insertUser(t, row);
      case 'accessories': return insertInventoryItem(t, 'accessories', 'available_qty', row);
      case 'consumables': return insertInventoryItem(t, 'consumables', 'remaining_qty', row);
      case 'components': return insertInventoryItem(t, 'components', 'available_qty', row);
      case 'licenses': return insertLicense(t, row);
      case 'locations': return insertLocation(t, row);
      case 'sub_locations': return insertSubLocation(t, row);
      default: throw new HttpError(`No insert handler for: ${module}`, 400);
    }
  });
}

async function executeImport(module, rows, userId) {
  const total = rows.length;
  let imported = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      await insertRow(module, rows[i]);
      imported += 1;
    } catch (err) {
      errors.push(`Row ${i + 2}: ${err.message}`);
    }
  }
  const failed = total - imported;
  await db.run(
    'INSERT INTO import_jobs (type, status, rows_total, rows_imported, errors, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [module, failed > 0 ? 'partial' : 'completed', total, imported, errors.join('\n'), userId]);
  const cache = require('../core/cache');
  cache.del('hams_dashboard_metrics');
  return { total, imported, failed, errors };
}

async function importHistory() {
  return db.query(
    `SELECT j.*, u.name AS user_name FROM import_jobs j
     LEFT JOIN users u ON j.created_by = u.id ORDER BY j.created_at DESC LIMIT 100`);
}

async function generateTemplate(module) {
  const columns = await getColumnsWithCustomFields(module);
  if (!columns.length) throw new HttpError(`Unknown module: ${module}`, 400);
  return columns.map(c => c[0]).join(',') + '\n';
}

// ---- Filtered exports (export-center) ----
async function getFilterOptions() {
  const [categories, manufacturers, locations, suppliers, statusLabels, roles, statuses] = await Promise.all([
    db.query('SELECT id, name FROM asset_categories ORDER BY name'),
    db.query('SELECT id, name FROM manufacturers ORDER BY name'),
    db.query('SELECT id, name FROM locations ORDER BY name'),
    db.query('SELECT id, name FROM suppliers ORDER BY name'),
    db.query('SELECT id, name FROM status_labels ORDER BY name'),
    db.query(`SELECT DISTINCT role FROM users WHERE role IS NOT NULL AND role != '' AND deleted_at IS NULL`),
    db.query('SELECT DISTINCT status FROM users WHERE deleted_at IS NULL')
  ]);
  return {
    categories, manufacturers, locations, suppliers, status_labels: statusLabels,
    user_roles: roles.map(r => r.role), user_statuses: statuses.map(r => r.status)
  };
}

async function exportFiltered(module, filters = {}) {
  const params = [];
  let i = 1;
  const like = v => { params.push(`%${v}%`); return `$${i++}`; };
  const eq = v => { params.push(v); return `$${i++}`; };

  switch (module) {
    case 'assets': {
      const where = ['a.deleted_at IS NULL'];
      if (filters.search) { const p = like(filters.search); where.push(`(a.name ILIKE ${p} OR a.asset_tag ILIKE ${p} OR a.serial_number ILIKE ${p})`); }
      if (filters.category_id) where.push(`a.category_id = ${eq(filters.category_id)}`);
      if (filters.status_label_id) where.push(`a.status_label_id = ${eq(filters.status_label_id)}`);
      if (filters.location_id) where.push(`a.location_id = ${eq(filters.location_id)}`);
      if (filters.date_from) where.push(`a.purchase_date >= ${eq(filters.date_from)}`);
      if (filters.date_to) where.push(`a.purchase_date <= ${eq(filters.date_to)}`);
      return db.query(
        `SELECT a.id, a.asset_tag, a.name, a.serial_number, a.model_number,
                COALESCE(ac.name, a.category) AS category, COALESCE(sl.name, a.status) AS status,
                l.name AS location, sub.name AS sub_location,
                u.name AS assigned_user, u.email AS assigned_user_email, u.employee_id AS assigned_employee_id,
                a.purchase_date, a.purchase_cost, a.warranty_expiry, a.notes, a.custom_fields_data, a.created_at
         FROM assets a
         LEFT JOIN asset_categories ac ON a.category_id = ac.id
         LEFT JOIN status_labels sl ON a.status_label_id = sl.id
         LEFT JOIN locations l ON a.location_id = l.id
         LEFT JOIN sub_locations sub ON a.sub_location_id = sub.id
         LEFT JOIN users u ON a.assigned_to = u.id
         WHERE ${where.join(' AND ')} ORDER BY a.id`, params);
    }
    case 'users': {
      const where = ['deleted_at IS NULL'];
      if (filters.search) { const p = like(filters.search); where.push(`(name ILIKE ${p} OR email ILIKE ${p})`); }
      if (filters.role) where.push(`role = ${eq(filters.role)}`);
      if (filters.status) where.push(`status = ${eq(filters.status)}`);
      return db.query(`SELECT id, employee_id, name, email, role, status, created_at FROM users WHERE ${where.join(' AND ')} ORDER BY id`, params);
    }
    case 'accessories':
    case 'consumables':
    case 'components': {
      const availCol = module === 'consumables' ? 'remaining_qty' : 'available_qty';
      const holderAlias = module === 'accessories' ? 'assigned_users' : (module === 'consumables' ? 'issued_users' : 'installed_assets');
      const where = ['i.deleted_at IS NULL'];
      if (filters.search) where.push(`i.name ILIKE ${like(filters.search)}`);
      if (filters.category_id) where.push(`i.category_id = ${eq(filters.category_id)}`);
      if (filters.manufacturer_id) where.push(`i.manufacturer_id = ${eq(filters.manufacturer_id)}`);
      if (filters.location_id) where.push(`i.location_id = ${eq(filters.location_id)}`);
      if (filters.low_stock) where.push(`(i.min_qty > 0 AND i.${availCol} <= i.min_qty)`);
      let holderSql;
      if (module === 'accessories') {
        holderSql = `(SELECT STRING_AGG(u.name, ', ') FROM accessory_assignments aa JOIN users u ON aa.user_id = u.id WHERE aa.accessory_id = i.id AND aa.returned_at IS NULL)`;
      } else if (module === 'consumables') {
        holderSql = `(SELECT STRING_AGG(u.name, ', ') FROM consumable_issues ci JOIN users u ON ci.user_id = u.id WHERE ci.consumable_id = i.id)`;
      } else {
        holderSql = `(SELECT STRING_AGG(a.name || ' (' || COALESCE(a.asset_tag, '') || ')', ', ') FROM component_assignments ca JOIN assets a ON ca.asset_id = a.id WHERE ca.component_id = i.id AND ca.removed_at IS NULL)`;
      }
      const identityCols = module === 'accessories' ? 'i.model_number, i.serial_number,' : (module === 'components' ? 'i.serial_number,' : '');
      return db.query(
        `SELECT i.id, i.name, ${identityCols} ac.name AS category, m.name AS manufacturer,
                l.name AS location, sub.name AS sub_location,
                i.total_qty, i.${availCol} AS available_qty, i.min_qty,
                ${holderSql} AS ${holderAlias}, i.notes, i.custom_fields_data
         FROM ${module} i
         LEFT JOIN asset_categories ac ON i.category_id = ac.id
         LEFT JOIN manufacturers m ON i.manufacturer_id = m.id
         LEFT JOIN locations l ON i.location_id = l.id
         LEFT JOIN sub_locations sub ON i.sub_location_id = sub.id
         WHERE ${where.join(' AND ')} ORDER BY i.id`, params);
    }
    case 'licenses': {
      const where = ['li.deleted_at IS NULL'];
      if (filters.search) where.push(`li.name ILIKE ${like(filters.search)}`);
      if (filters.manufacturer_id) where.push(`li.manufacturer_id = ${eq(filters.manufacturer_id)}`);
      if (filters.expired) where.push(`li.expiration_date < CURRENT_DATE`);
      if (filters.date_from) where.push(`li.expiration_date >= ${eq(filters.date_from)}`);
      if (filters.date_to) where.push(`li.expiration_date <= ${eq(filters.date_to)}`);
      return db.query(
        `SELECT li.id, li.name, m.name AS manufacturer, l.name AS location, sub.name AS sub_location,
                li.seats, li.available_seats,
                (SELECT STRING_AGG(COALESCE(u.name, a.name), ', ') FROM license_assignments la
                  LEFT JOIN users u ON la.user_id = u.id LEFT JOIN assets a ON la.asset_id = a.id
                  WHERE la.license_id = li.id AND la.revoked_at IS NULL) AS assigned_to,
                li.license_key, li.expiration_date, li.notes, li.custom_fields_data
         FROM licenses li
         LEFT JOIN manufacturers m ON li.manufacturer_id = m.id
         LEFT JOIN locations l ON li.location_id = l.id
         LEFT JOIN sub_locations sub ON li.sub_location_id = sub.id
         WHERE ${where.join(' AND ')} ORDER BY li.id`, params);
    }
    case 'locations': {
      const where = ['1=1'];
      if (filters.search) { const p = like(filters.search); where.push(`(name ILIKE ${p} OR city ILIKE ${p} OR country ILIKE ${p})`); }
      if (filters.country) where.push(`country = ${eq(filters.country)}`);
      return db.query(`SELECT id, name, address, city, country FROM locations WHERE ${where.join(' AND ')} ORDER BY id`, params);
    }
    case 'sub_locations': {
      const where = ['sl.deleted_at IS NULL'];
      if (filters.search) { const p = like(filters.search); where.push(`(sl.name ILIKE ${p} OR sl.code ILIKE ${p} OR l.name ILIKE ${p})`); }
      if (filters.location_id) where.push(`sl.location_id = ${eq(filters.location_id)}`);
      return db.query(
        `SELECT sl.id, sl.name, sl.code, sl.floor, sl.room, l.name AS location, sl.notes
         FROM sub_locations sl LEFT JOIN locations l ON sl.location_id = l.id
         WHERE ${where.join(' AND ')} ORDER BY sl.id`, params);
    }
    case 'audit_logs': {
      const where = ['1=1'];
      if (filters.search) where.push(`l.description ILIKE ${like(filters.search)}`);
      if (filters.action) where.push(`l.action = ${eq(filters.action)}`);
      if (filters.date_from) where.push(`l.created_at >= ${eq(filters.date_from)}`);
      if (filters.date_to) where.push(`l.created_at <= ${eq(filters.date_to + ' 23:59:59')}`);
      return db.query(
        `SELECT l.created_at, l.action, l.description, u.name AS "user"
         FROM activity_logs l LEFT JOIN users u ON l.user_id = u.id
         WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC`, params);
    }
    default:
      throw new HttpError(`Unknown module: ${module}`, 400);
  }
}

// Expand custom_fields_data JSON into cf_* keys per row
function rowIterator(row) {
  const out = { ...row };
  if (out.custom_fields_data !== undefined) {
    let cf = out.custom_fields_data;
    if (typeof cf === 'string') { try { cf = JSON.parse(cf); } catch (_) { cf = null; } }
    if (cf && typeof cf === 'object') {
      for (const [k, v] of Object.entries(cf)) out['cf_' + k] = v;
    }
    delete out.custom_fields_data;
  }
  return out;
}

module.exports = {
  MODULES, getModuleConfig, getColumnsWithCustomFields, getModules,
  parseUpload, validateRows, executeImport, importHistory, generateTemplate,
  getFilterOptions, exportFiltered, rowIterator
};
