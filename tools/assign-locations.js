// Assign the 10 canonical CitiusTech sites + their sub-locations to the already-
// imported Users, Hardware Assets and Accessories. These records were imported with
// raw location strings that did not match the canonical site names, so location_id /
// sub_location_id were left NULL. This backfills them using ONLY real source data:
//
//  - Assets & Accessories: joined to their source CSV by serial_number; the row's
//    own `location` string is mapped to the matching canonical site.
//  - Users: joined to Location data.csv by name; that person's city -> canonical site.
//  - Sub-location: the source `sub_location` strings are campus/building names, not
//    the 3 functional sub-locations that exist per site. So sub-location is derived
//    from ALLOCATION STATE: allocated -> "Workstation Floor", in stock -> "IT Asset
//    Store" (both belonging to the record's own site). Users have no sub-location col.
//
// No values are invented. Records whose raw location has no canonical site (e.g. the
// dropped "Poland") or whose name/serial doesn't match are left NULL and reported.
const fs = require('fs');
const db = require('../src/core/db');

const DIR = 'C:/Users/40211/Downloads/Dataset';

// raw location string (assets/accessories)  ->  canonical site name
const LOC_TO_SITE = {
  'Hyderabad': 'CitiusTech Hyderabad',
  'USA': 'CitiusTech US',
  'Onsite USA': 'CitiusTech US',
  'Mumbai': 'CT Powai',
  'Mindspace Mumbai': 'CitiusTech SEZ3',
  'Pune': 'CT Pune Qubix SEZ1',
  'Bangalore': 'CitiusTech Bangalore SEZ1',
  'Chennai': 'CitiusTech Chennai SEZ',
  'Noida': 'CitiusTech Noida',
  'Gurugram': 'CitiusTech Gurugram',
  'Canada': 'CitiusTech Canada',
  // 'Poland' has no canonical site (dropped as garbled) -> intentionally unmapped
};
// Location data.csv city  ->  canonical site name (for users)
const CITY_TO_SITE = {
  'Hyderabad': 'CitiusTech Hyderabad',
  'Prinston': 'CitiusTech US',
  'Navi Mumbai': 'CitiusTech SEZ3',
  'Mumbai': 'CT Powai',
  'Pune': 'CT Pune Qubix SEZ1',
  'Bangalore': 'CitiusTech Bangalore SEZ1',
  'Chennai': 'CitiusTech Chennai SEZ',
  'Noida': 'CitiusTech Noida',
  'Gurugram': 'CitiusTech Gurugram',
  'Ottawa': 'CitiusTech Canada',
};

function parseCsv(file) {
  const L = fs.readFileSync(`${DIR}/${file}`, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const H = L[0].split(',');
  const rows = L.slice(1).map(line => {
    const c = []; let cur = '', q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { c.push(cur); cur = ''; } else cur += ch; }
    c.push(cur); return c;
  });
  const idx = n => H.indexOf(n);
  return { rows, idx };
}
const normName = s => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();

(async () => {
  // ---- canonical lookups ----
  const sites = await db.query('SELECT id, name FROM locations WHERE deleted_at IS NULL');
  const siteId = Object.fromEntries(sites.map(s => [s.name, s.id]));
  const subs = await db.query('SELECT id, location_id, name FROM sub_locations WHERE deleted_at IS NULL');
  const subId = (locId, name) => (subs.find(s => s.location_id === locId && s.name === name) || {}).id || null;
  const WS = 'Workstation Floor', STORE = 'IT Asset Store';

  const report = { users: {}, assets: {}, accessories: {} };
  const tick = (b, k) => (b[k] = (b[k] || 0) + 1);

  await db.tx(async t => {
    // ===== USERS: name -> city -> site =====
    const loc = parseCsv('Location data.csv');
    const ni = loc.idx('name'), ci = loc.idx('city');
    const personCity = new Map();          // normalized name -> city (first wins)
    for (const r of loc.rows) {
      const nm = normName(r[ni]); const city = (r[ci] || '').trim();
      if (!nm || nm === '#n/a') continue;
      if (!personCity.has(nm)) personCity.set(nm, city);
    }
    const users = await t.query('SELECT id, name FROM users WHERE deleted_at IS NULL');
    for (const u of users) {
      const city = personCity.get(normName(u.name));
      const site = city && CITY_TO_SITE[city];
      const lid = site ? siteId[site] : null;
      if (!lid) { tick(report.users, city ? `no-site:${city}` : 'name-unmatched'); continue; }
      await t.run('UPDATE users SET location_id = $1 WHERE id = $2', [lid, u.id]);
      tick(report.users, site);
    }

    // ===== ASSETS: serial -> raw location -> site; sub by allocation =====
    const a = parseCsv('Asset hardware data (filled).csv');
    const asi = a.idx('serial_number'), ali = a.idx('location');
    const assetSrc = new Map();
    for (const r of a.rows) { const s = (r[asi] || '').trim(); if (s) assetSrc.set(s, (r[ali] || '').trim()); }
    const assets = await t.query('SELECT id, serial_number, assigned_to, status FROM assets WHERE deleted_at IS NULL');
    for (const as of assets) {
      const raw = as.serial_number && assetSrc.get(as.serial_number.trim());
      const site = raw && LOC_TO_SITE[raw];
      const lid = site ? siteId[site] : null;
      if (!lid) { tick(report.assets, raw ? `no-site:${raw}` : 'serial-unmatched'); continue; }
      const allocated = as.assigned_to != null;
      const sid = subId(lid, allocated ? WS : STORE);
      await t.run('UPDATE assets SET location_id = $1, sub_location_id = $2 WHERE id = $3', [lid, sid, as.id]);
      tick(report.assets, `${site} / ${allocated ? WS : STORE}`);
    }

    // ===== ACCESSORIES: serial -> raw location -> site; sub by stock level =====
    const c = parseCsv('Accessaries data (filled).csv');
    const csi = c.idx('serial_number'), cli = c.idx('location');
    const accSrc = new Map();
    for (const r of c.rows) { const s = (r[csi] || '').trim(); if (s) accSrc.set(s, (r[cli] || '').trim()); }
    const accs = await t.query('SELECT id, serial_number, total_qty, available_qty FROM accessories WHERE deleted_at IS NULL');
    for (const ac of accs) {
      const raw = ac.serial_number && accSrc.get(ac.serial_number.trim());
      const site = raw && LOC_TO_SITE[raw];
      const lid = site ? siteId[site] : null;
      if (!lid) { tick(report.accessories, raw ? `no-site:${raw}` : 'serial-unmatched'); continue; }
      const assigned = (Number(ac.total_qty) || 0) - (Number(ac.available_qty) || 0) > 0;
      const sid = subId(lid, assigned ? WS : STORE);
      await t.run('UPDATE accessories SET location_id = $1, sub_location_id = $2 WHERE id = $3', [lid, sid, ac.id]);
      tick(report.accessories, `${site} / ${assigned ? WS : STORE}`);
    }
  });

  const dump = (label, b) => {
    console.log(`\n${label}:`);
    for (const [k, v] of Object.entries(b).sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  };
  dump('USERS  (location_id)', report.users);
  dump('ASSETS (location_id + sub_location_id)', report.assets);
  dump('ACCESSORIES (location_id + sub_location_id)', report.accessories);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
