// Fill the missing category_id on Accessories. The source file HAS a `category`
// value for every row (Desktop Monitor / Headphone), but those accessory-type
// categories did not exist at import time and resolveFk() only looks up (never
// creates) — so category_id was left NULL on all 96 rows.
//
// Fix: create the accessory-type categories named exactly as the source, then link
// each accessory by serial_number -> its source category. No values invented.
const fs = require('fs');
const db = require('../src/core/db');

const DIR = 'C:/Users/40211/Downloads/Dataset';
const COLORS = { 'Desktop Monitor': '#06b6d4', 'Headphone': '#a855f7' }; // cosmetic only

function readCsv(file) {
  const L = fs.readFileSync(`${DIR}/${file}`, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const H = L[0].split(',');
  const rows = L.slice(1).map(line => {
    const c = []; let cur = '', q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { c.push(cur); cur = ''; } else cur += ch; }
    c.push(cur); return c;
  });
  return { rows, idx: n => H.indexOf(n) };
}

(async () => {
  const src = readCsv('Accessaries data (filled).csv');
  const si = src.idx('serial_number'), ci = src.idx('category');
  const serCat = new Map();
  for (const r of src.rows) { const s = (r[si] || '').trim().toUpperCase(); const c = (r[ci] || '').trim(); if (s && c) serCat.set(s, c); }

  const report = {};
  const tick = k => (report[k] = (report[k] || 0) + 1);

  await db.tx(async t => {
    // ensure each distinct accessory category exists as type='accessory'
    const catId = {};
    for (const name of [...new Set(serCat.values())]) {
      const existing = await t.get("SELECT id FROM asset_categories WHERE name = $1 AND type = 'accessory' AND deleted_at IS NULL", [name]);
      catId[name] = existing ? existing.id
        : await t.insert("INSERT INTO asset_categories (name, type, color) VALUES ($1, 'accessory', $2)", [name, COLORS[name] || '#64748b']);
    }

    const accs = await t.query('SELECT id, serial_number FROM accessories WHERE deleted_at IS NULL');
    for (const a of accs) {
      const cat = a.serial_number && serCat.get(a.serial_number.trim().toUpperCase());
      if (!cat) { tick('UNRESOLVED'); continue; }
      await t.run('UPDATE accessories SET category_id = $1 WHERE id = $2', [catId[cat], a.id]);
      tick(cat);
    }
  });

  console.log('Accessory categories filled:');
  for (const [k, v] of Object.entries(report).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
