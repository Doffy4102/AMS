// Port of DataTransferService: raw column-mapped export/import.
const fs = require('fs');
const path = require('path');
const db = require('../core/db');
const config = require('../config');
const { HttpError } = require('../core/helpers');

const TABLES = ['assets', 'users', 'procurement', 'inventory_items', 'licenses'];
const TABLE_MAP = {
  assets: 'assets', users: 'users', procurement: 'procurement_records',
  inventory_items: 'accessories', licenses: 'licenses'
};

function assertTable(table, action = 'transfer') {
  if (!TABLES.includes(table)) throw new HttpError(`Invalid table selected for ${action}.`, 400);
  return TABLE_MAP[table];
}

async function getTableColumns(table) {
  const real = assertTable(table);
  const rows = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [real]);
  return rows.map(r => r.column_name);
}

async function exportRows(table, columns = [], filters = []) {
  const real = assertTable(table);
  const validCols = await getTableColumns(table);
  const selected = (columns || []).filter(c => validCols.includes(c));
  const selectSql = selected.length ? selected.map(c => `"${c}"`).join(', ') : '*';
  const where = ['1=1'];
  const params = [];
  let i = 1;
  for (const f of filters) {
    if (!f.column || !validCols.includes(f.column)) continue;
    if (f.operator === 'LIKE') {
      where.push(`"${f.column}"::text ILIKE $${i++}`);
      params.push(`%${f.value}%`);
    } else {
      where.push(`"${f.column}"::text = $${i++}`);
      params.push(String(f.value));
    }
  }
  return db.query(`SELECT ${selectSql} FROM ${real} WHERE ${where.join(' AND ')}`, params);
}

function parseCsvForMapping(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r\n|\r|\n/).filter(l => l.trim());
  if (!lines.length) return { headers: [], preview: [] };
  const parse = line => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parse(lines[0]);
  const preview = lines.slice(1, 4).map(parse);
  return { headers, preview };
}

function tempDir() {
  const dir = path.join(config.storageDir, 'temp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function executeMappedImport(table, filePath, mapping, userId) {
  const real = assertTable(table, 'import');
  const validCols = await getTableColumns(table);
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r\n|\r|\n/).filter(l => l.trim());
  if (lines.length < 2) return { imported: 0, failed: 0 };

  const parse = line => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parse(lines[0]);
  const indexMap = {}; // csv index -> db col
  headers.forEach((h, idx) => {
    const col = mapping && mapping[h];
    if (col && validCols.includes(col)) indexMap[idx] = col;
  });
  if (!Object.keys(indexMap).length) throw new HttpError('No valid column mappings provided.', 422);

  const cols = Object.values(indexMap);
  const serialIdx = table === 'assets' ? cols.indexOf('serial_number') : -1;
  let imported = 0, failed = 0;
  await db.tx(async t => {
    for (let li = 1; li < lines.length; li++) {
      const vals = parse(lines[li]);
      const rowVals = Object.keys(indexMap).map(idx => {
        const v = vals[parseInt(idx, 10)];
        return v === undefined || v === '' ? null : v;
      });
      if (serialIdx >= 0 && rowVals[serialIdx]) {
        const dup = await t.get('SELECT id FROM assets WHERE serial_number = $1 AND deleted_at IS NULL', [rowVals[serialIdx]]);
        if (dup) { failed += 1; continue; }
      }
      try {
        await t.run(
          `INSERT INTO ${real} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i2) => `$${i2 + 1}`).join(', ')})`,
          rowVals);
        imported += 1;
      } catch (_) {
        failed += 1;
      }
    }
  });
  await db.run(
    'INSERT INTO import_jobs (type, status, rows_total, rows_imported, errors, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [`data_transfer_${table}`, failed > 0 ? 'partial' : 'completed', lines.length - 1, imported, '', userId]);
  return { imported, failed };
}

module.exports = { TABLES, getTableColumns, exportRows, parseCsvForMapping, executeMappedImport, tempDir };
