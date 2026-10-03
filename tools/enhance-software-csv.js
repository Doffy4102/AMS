// Feature 1: enhance the Software Asset CSV in place with three new columns —
// Market Name, Client Name, User Name — and mirror the same assignment into
// software_assets (market_name, client_name, allocated_user_id), matched
// row-for-row by the CSV "Sr." column == software_assets.sr_no.
//
// - Market Name: weighted-random across the six markets so the spread looks
//   like a real org (delivery markets bigger than Functions).
// - Client Name: 4 existing + 6 added healthcare/enterprise clients, roughly
//   balanced with the existing four slightly heavier.
// - User Name: REAL names pulled from the users table (never invented).
//   ~65% of records get a user (allocated); the rest stay blank (unallocated).
//   The DB stores the user's id (FK) — the name lands only in the CSV.
// Deterministic: a seeded PRNG keyed by sr_no makes re-runs reproducible.
//
// Usage: node tools/enhance-software-csv.js "<path-to-csv>"
const fs = require('fs');
const db = require('../src/core/db');

const CSV_PATH = process.argv[2] ||
  'C:/Users/40211/Downloads/krishnam3-Software_Asset_Synthetic_1000(SoftwareAssets)/Software_Asset_Synthetic_1000(SoftwareAssets).csv';

const MARKETS = [
  ['HMT1', 22], ['HMT2', 18], ['HPR', 15], ['HLS', 14], ['HHP', 12], ['Functions (IT)', 19]
];
const CLIENTS = [
  // existing four, slightly heavier
  ['GE Healthcare', 13], ['Athena', 12], ['Devita', 12], ['Cambia', 11],
  // six added healthcare/enterprise clients
  ['UnitedHealth Group', 9], ['Kaiser Permanente', 9], ['Cigna', 9],
  ['CVS Health', 9], ['Humana', 8], ['Elevance Health', 8]
];
const ALLOCATED_SHARE = 0.65;

// Small deterministic PRNG (mulberry32) seeded per row.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(list, r) {
  const total = list.reduce((a, [, w]) => a + w, 0);
  let x = r * total;
  for (const [value, w] of list) { x -= w; if (x <= 0) return value; }
  return list[list.length - 1][0];
}

// Minimal CSV line parser/serializer (quotes + embedded commas).
function parseLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function toCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

(async () => {
  // Real user names from the existing directory (employees only, no system admin).
  const users = await db.query(
    `SELECT id, name FROM users
      WHERE deleted_at IS NULL AND status = 'active' AND role <> 'super_admin'
      ORDER BY id`);
  if (!users.length) throw new Error('No active users found to allocate from.');
  console.log(`Allocating from ${users.length} existing users.`);

  const raw = fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
  const headers = parseLine(lines[0]);
  const srIdx = headers.findIndex(h => /^sr\.?$/i.test(h.trim()));
  if (srIdx < 0) throw new Error('CSV has no "Sr." column.');
  for (const col of ['Market Name', 'Client Name', 'User Name']) {
    if (headers.some(h => h.trim().toLowerCase() === col.toLowerCase())) {
      throw new Error(`CSV already has a "${col}" column — refusing to double-enhance.`);
    }
  }

  const outLines = [[...headers, 'Market Name', 'Client Name', 'User Name'].map(toCell).join(',')];
  let updated = 0, allocated = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const srNo = parseInt(cols[srIdx], 10);
    if (!Number.isInteger(srNo)) { skipped++; outLines.push(lines[i]); continue; }

    const r = rng(srNo * 7919 + 13);
    const market = weightedPick(MARKETS, r());
    const client = weightedPick(CLIENTS, r());
    const user = r() < ALLOCATED_SHARE ? users[Math.floor(r() * users.length)] : null;

    outLines.push([...cols, market, client, user ? user.name : ''].map(toCell).join(','));

    const res = await db.run(
      `UPDATE software_assets
          SET market_name = $1, client_name = $2, allocated_user_id = $3
        WHERE sr_no = $4`,
      [market, client, user ? user.id : null, srNo]);
    if (res.rowCount) updated++;
    if (user) allocated++;
  }

  fs.writeFileSync(CSV_PATH, outLines.join('\n') + '\n', 'utf8');
  console.log(`CSV rewritten: ${CSV_PATH}`);
  console.log(`Rows: ${lines.length - 1} | DB rows updated: ${updated} | allocated: ${allocated} | skipped: ${skipped}`);

  const mk = await db.query('SELECT market_name, COUNT(*) n FROM software_assets GROUP BY 1 ORDER BY 2 DESC');
  console.log('\nMarket distribution:'); mk.forEach(x => console.log(' ', x.market_name, x.n));
  const cl = await db.query('SELECT client_name, COUNT(*) n FROM software_assets GROUP BY 1 ORDER BY 2 DESC');
  console.log('Client distribution:'); cl.forEach(x => console.log(' ', x.client_name, x.n));
  const al = await db.get(`SELECT COUNT(*) FILTER (WHERE allocated_user_id IS NOT NULL) a,
                                  COUNT(*) FILTER (WHERE allocated_user_id IS NULL) u FROM software_assets`);
  console.log('Allocated:', al.a, '| Not allocated:', al.u);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
