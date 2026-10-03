// Populate the empty `manufacturers` table and link Hardware Assets + Accessories
// to it. Manufacturers are NOT a standalone Import Center module (they are resolved
// as an FK during asset/accessory import), and the imported records carried no
// manufacturer, so this backfills from real source CSVs — nothing invented.
//
// Sources (priority order), all joined by serial number:
//   ASSETS:
//     1. "Asset Data Inventory.csv"  -> "Manufacturer Name"  (authoritative, 440/442)
//     2. "DevicesWithInventory.csv"  -> "Manufacturer"       (MDM fallback)
//     3. model_number brand keywords (ThinkPad->Lenovo, MacBook->Apple, ...) fallback
//   ACCESSORIES:
//     - "Accessaries data (filled).csv" explicit `manufacturer` column (96/96)
//
// Also writes "Manufacturer data.csv" (distinct names) as an uploadable artifact.
const fs = require('fs');
const db = require('../src/core/db');

const DIR = 'C:/Users/40211/Downloads/Dataset';
const DEVICES = 'DevicesWithInventory_dc55b100-7eba-47b6-9d9e-7da27eb439f3.csv';

// quote-aware CSV -> array of cell-arrays
function readCsv(file) {
  const raw = fs.readFileSync(`${DIR}/${file}`, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  const parse = line => {
    const c = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { c.push(cur); cur = ''; } else cur += ch;
    }
    c.push(cur); return c;
  };
  const header = parse(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) if (lines[i].trim()) rows.push(parse(lines[i]));
  return { header, rows, idx: n => header.indexOf(n) };
}

// canonicalize manufacturer name variants that clearly denote the same maker
function normMfr(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const map = {
    'Dell Inc.': 'Dell', 'DELL': 'Dell',
    'LENOVO': 'Lenovo',
    'Hewlett-Packard': 'HP', 'Hewlett Packard': 'HP', 'HPE': 'HP',
    'Microsoft Corporation': 'Microsoft',
    'Cisco Systems, Inc': 'Cisco', 'Cisco Systems, Inc.': 'Cisco',
    'Sony Corporation': 'Sony',
    'samsung': 'Samsung', 'SAMSUNG': 'Samsung',
    'VMware, Inc.': 'VMware',
    'motorola': 'Motorola', 'LGE': 'LG',
  };
  return map[s] || s;
}
function inferFromModel(m) {
  m = (m || '').toLowerCase();
  if (/thinkpad|thinkbook|ideapad|yoga|lenovo|legion|\bv130\b|v130-/.test(m)) return 'Lenovo';
  if (/macbook|imac|mac mini|\bmacos\b/.test(m)) return 'Apple';
  if (/latitude|optiplex|precision|inspiron|\bxps\b|\bdell\b/.test(m)) return 'Dell';
  if (/elitebook|probook|pavilion|\bhp\b/.test(m)) return 'HP';
  if (/surface/.test(m)) return 'Microsoft';
  return null;
}

(async () => {
  // ---- build serial -> manufacturer lookups ----
  const inv = readCsv('Asset Data Inventory.csv');           // Service Tag # (3), Manufacturer Name (20)
  const invTag = inv.idx('Service Tag #'), invMfr = inv.idx('Manufacturer Name');
  const invMap = new Map();
  for (const r of inv.rows) { const t = (r[invTag] || '').trim().toUpperCase(); const m = (r[invMfr] || '').trim(); if (t && m) invMap.set(t, m); }

  const dev = readCsv(DEVICES);                              // Serial number (8), Manufacturer (9)
  const devSer = dev.idx('Serial number'), devMfr = dev.idx('Manufacturer');
  const devMap = new Map();
  for (const r of dev.rows) { const s = (r[devSer] || '').trim().toUpperCase(); const m = (r[devMfr] || '').trim(); if (s && m && !devMap.has(s)) devMap.set(s, m); }

  const acc = readCsv('Accessaries data (filled).csv');      // serial_number, manufacturer
  const accSer = acc.idx('serial_number'), accMfr = acc.idx('manufacturer');
  const accMap = new Map();
  for (const r of acc.rows) { const s = (r[accSer] || '').trim().toUpperCase(); const m = (r[accMfr] || '').trim(); if (s && m) accMap.set(s, m); }

  const report = { assets: {}, accessories: {} };
  const tick = (b, k) => (b[k] = (b[k] || 0) + 1);

  await db.tx(async t => {
    // decide manufacturer for every asset / accessory first, collect distinct names
    const assets = await t.query('SELECT id, serial_number, model_number FROM assets WHERE deleted_at IS NULL');
    const accs = await t.query('SELECT id, serial_number FROM accessories WHERE deleted_at IS NULL');

    const assetPick = new Map();   // asset id -> normalized mfr
    for (const a of assets) {
      const s = (a.serial_number || '').trim().toUpperCase();
      let src = 'none', raw = (s && invMap.get(s));
      if (raw) src = 'inventory';
      else if (s && devMap.get(s)) { raw = devMap.get(s); src = 'device'; }
      else { raw = inferFromModel(a.model_number); if (raw) src = 'model'; }
      const mfr = normMfr(raw);
      if (mfr) { assetPick.set(a.id, mfr); tick(report.assets, `${mfr} [${src}]`); }
      else tick(report.assets, 'UNRESOLVED');
    }
    const accPick = new Map();
    for (const c of accs) {
      const s = (c.serial_number || '').trim().toUpperCase();
      const mfr = normMfr(s && accMap.get(s));
      if (mfr) { accPick.set(c.id, mfr); tick(report.accessories, mfr); }
      else tick(report.accessories, 'UNRESOLVED');
    }

    // create manufacturers (distinct), get name -> id
    const names = [...new Set([...assetPick.values(), ...accPick.values()])].sort();
    const nameId = {};
    for (const name of names) {
      const existing = await t.get('SELECT id FROM manufacturers WHERE name = $1', [name]);
      nameId[name] = existing ? existing.id : await t.insert('INSERT INTO manufacturers (name) VALUES ($1)', [name]);
    }

    // link
    for (const [id, mfr] of assetPick) await t.run('UPDATE assets SET manufacturer_id = $1 WHERE id = $2', [nameId[mfr], id]);
    for (const [id, mfr] of accPick) await t.run('UPDATE accessories SET manufacturer_id = $1 WHERE id = $2', [nameId[mfr], id]);

    // uploadable artifact
    fs.writeFileSync(`${DIR}/Manufacturer data.csv`, 'name\n' + names.join('\n') + '\n', 'utf8');
    report._names = names;
  });

  const dump = (label, b) => {
    console.log(`\n${label}:`);
    for (const [k, v] of Object.entries(b).filter(([k]) => k !== '_names').sort((x, y) => y[1] - x[1]))
      console.log(`  ${String(v).padStart(4)}  ${k}`);
  };
  console.log('Distinct manufacturers created:', report._names.length, '->', report._names.join(', '));
  dump('ASSETS (manufacturer_id, by source)', report.assets);
  dump('ACCESSORIES (manufacturer_id)', report.accessories);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
