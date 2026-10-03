// Prep the 4 user-supplied Dataset CSVs into import-ready files.
//   Location data.csv  -> locations + sub-locations (derived: its `name` column
//                         holds person names; real sites come from the location/
//                         sub_location references in the asset & accessory files)
//   User data.csv      -> users   (status Allocated->active, dedupe, drop blanks/#N/A)
//   Asset hardware data.csv -> assets (person -> user col, model as name, ISO dates)
//   Accessaries data.csv    -> accessories (qty=1 per serialized unit)
// Usage: node tools/prep-dataset.js "C:/Users/40211/Downloads/Dataset"
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/40211/Downloads/Dataset';
const OUT = path.join(__dirname, '..', 'sample-data', 'import-ready');
fs.mkdirSync(OUT, { recursive: true });

const t = v => (v === null || v === undefined) ? '' : String(v).trim();
const JUNK = new Set(['', '#n/a', 'na', 'n/a', 'nil', '-']);
const isJunk = v => JUNK.has(t(v).toLowerCase());

// These exports are unquoted CSVs that contain literal double quotes
// (e.g. MacBook Pro 13.3") — treat quotes as data, split on commas only.
function parseCsv(text) {
  return text.replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .map(line => line.split(','))
    .filter(row => row.some(f => t(f) !== ''));
}

function csvEscape(v) {
  const s = t(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(','));
  fs.writeFileSync(path.join(OUT, file), lines.join('\n') + '\n', 'utf8');
}

function parseDate(v) { // dd-MMM-yy(yy) -> ISO
  const m = t(v).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return '';
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const mon = months[m[2].toLowerCase()];
  if (!mon) return '';
  let y = parseInt(m[3], 10); if (y < 100) y += y >= 70 ? 1900 : 2000;
  const d = parseInt(m[1], 10);
  if (d < 1 || d > 31 || y < 1990 || y > 2040) return '';
  return `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Realign rows that gained fields from unquoted commas (anchor: status/date cols)
function realign(row, expected, statusIdx, dateIdx) {
  if (row.length === expected) return row;
  if (row.length < expected) return row.concat(Array(expected - row.length).fill(''));
  const overflow = row.length - expected;
  let best = null, bestScore = -1;
  for (let pos = 0; pos < expected; pos++) {
    const merged = row.slice(0, pos)
      .concat([row.slice(pos, pos + overflow + 1).join(', ')])
      .concat(row.slice(pos + overflow + 1));
    let score = 0;
    if (/^(allocated|in repository|)$/i.test(t(merged[statusIdx]))) score += 3;
    if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(t(merged[dateIdx])) || t(merged[dateIdx]) === '') score += 1;
    if (score > bestScore) { bestScore = score; best = merged; }
  }
  return best || row.slice(0, expected);
}

// ---------- 1. Users ----------
const uRaw = parseCsv(fs.readFileSync(path.join(SRC, 'User data.csv'), 'utf8'));
const uHead = uRaw[0].map(t);
const ui = n => uHead.indexOf(n);
const users = [];
const seenEmails = new Set();
let uSkipped = 0, uDups = 0;
for (let i = 1; i < uRaw.length; i++) {
  const r = uRaw[i];
  const name = t(r[ui('name')]), email = t(r[ui('email')]);
  if (isJunk(name) || isJunk(email) || !email.includes('@')) { uSkipped++; continue; }
  const key = email.toLowerCase();
  if (seenEmails.has(key)) { uDups++; continue; }
  seenEmails.add(key);
  users.push({
    employee_id: isJunk(r[ui('employee_id')]) ? '' : t(r[ui('employee_id')]),
    name, email,
    role: t(r[ui('role')]) || 'employee',
    status: 'active' // source says "Allocated" which is an asset state, not a user state
  });
}
const userNames = new Map(); // name -> count (for safe user resolution by name)
for (const u of users) userNames.set(u.name, (userNames.get(u.name) || 0) + 1);
const resolvableName = n => userNames.get(n) === 1;
writeCsv('3_users.csv', ['employee_id', 'name', 'email', 'role', 'status'], users);

// ---------- 2. Read assets + accessories (needed to derive locations) ----------
const aRaw = parseCsv(fs.readFileSync(path.join(SRC, 'Asset hardware data.csv'), 'utf8'));
const aHead = aRaw[0].map(t);
const ai = n => aHead.indexOf(n);
const accRaw = parseCsv(fs.readFileSync(path.join(SRC, 'Accessaries data.csv'), 'utf8'));
const accHead = accRaw[0].map(t);
const ci = n => accHead.indexOf(n);

// Location metadata from "Location data.csv" (city/country distribution) + site knowledge
const CITY_FOR = {
  'Mindspace Mumbai': ['Navi Mumbai', 'India'], 'Mumbai': ['Mumbai', 'India'],
  'Pune': ['Pune', 'India'], 'Bangalore': ['Bangalore', 'India'], 'Chennai': ['Chennai', 'India'],
  'Hyderabad': ['Hyderabad', 'India'], 'Gurugram': ['Gurugram', 'India'], 'Noida': ['Noida', 'India'],
  'USA': ['Princeton', 'USA'], 'Onsite USA': ['Princeton', 'USA'], 'Poland': ['Warsaw', 'Poland'],
  'Canada': ['Ottawa', 'Canada']
};
const VALID_LOC = new Set(Object.keys(CITY_FOR));

const locSet = new Set();
const subLocSet = new Map(); // "loc||sub" -> {location, name}
function noteLoc(loc, sub) {
  loc = t(loc); sub = t(sub);
  if (VALID_LOC.has(loc)) {
    locSet.add(loc);
    if (sub && !isJunk(sub) && sub.length <= 60) subLocSet.set(loc + '||' + sub, { location: loc, name: sub });
  }
}

// ---------- 3. Assets ----------
const assets = [];
const seenTags = new Set(), seenSerials = new Set();
let aRealigned = 0, aTagDups = 0, aSerialDups = 0, aUserBlanked = 0, aSkipped = 0;
for (let i = 1; i < aRaw.length; i++) {
  let r = aRaw[i];
  if (r.length !== aHead.length) { r = realign(r, aHead.length, ai('status'), ai('purchase_date')); aRealigned++; }
  const g = n => t(r[ai(n)]);
  const serialRaw = g('serial_number');
  if (!serialRaw || isJunk(serialRaw)) { aSkipped++; continue; }

  let serial = serialRaw;
  if (seenSerials.has(serial)) {
    let n = 2, cand; do { cand = `${serial}-DUP${n++}`; } while (seenSerials.has(cand));
    serial = cand; aSerialDups++;
  }
  seenSerials.add(serial);

  let tag = g('asset_tag');
  if (!tag || isJunk(tag) || seenTags.has(tag)) {
    if (tag && seenTags.has(tag)) aTagDups++;
    tag = '';
  } else seenTags.add(tag);

  const person = g('name'); // person name lives in `name` in the source
  let user = g('user') && !isJunk(g('user')) ? g('user') : (isJunk(person) ? '' : person);
  let notes = g('notes');
  if (user && !resolvableName(user)) {
    notes = (notes ? notes + ' | ' : '') + 'Assigned to: ' + user;
    user = '';
    aUserBlanked++;
  }

  const model = g('model_number');
  const category = isJunk(g('category')) || !CITY_FOR ? g('category') : g('category');
  const loc = VALID_LOC.has(g('location')) ? g('location') : '';
  noteLoc(g('location'), g('sub_location'));

  assets.push({
    asset_tag: tag,
    name: model || (g('category') ? `${g('category')} ${serial}` : `Asset ${serial}`),
    serial_number: serial,
    model_number: model,
    category: isJunk(g('category')) ? '' : g('category'),
    location: loc,
    sub_location: loc && !isJunk(g('sub_location')) ? g('sub_location') : '',
    status: /^allocated/i.test(g('status')) ? 'assigned' : 'available',
    purchase_date: parseDate(g('purchase_date')),
    purchase_cost: /^\d+(\.\d+)?$/.test(g('purchase_cost')) && Number(g('purchase_cost')) > 0 ? g('purchase_cost') : '',
    warranty_expiry: parseDate(g('warranty_expiry')),
    user,
    notes
  });
}
writeCsv('4_assets.csv', ['asset_tag', 'name', 'serial_number', 'model_number', 'category', 'location',
  'sub_location', 'status', 'purchase_date', 'purchase_cost', 'warranty_expiry', 'user', 'notes'], assets);

// ---------- 4. Accessories ----------
const accessories = [];
const seenAccSerials = new Set();
let accSerialDups = 0, accUserBlanked = 0, accSkipped = 0;
for (let i = 1; i < accRaw.length; i++) {
  let r = accRaw[i];
  if (r.length !== accHead.length) r = realign(r, accHead.length, ci('category'), ci('category'));
  const g = n => t(r[ci(n)]);
  const serialRaw = g('serial_number');
  if (!serialRaw || isJunk(serialRaw)) { accSkipped++; continue; }
  let serial = serialRaw;
  if (seenAccSerials.has(serial)) {
    let n = 2, cand; do { cand = `${serial}-DUP${n++}`; } while (seenAccSerials.has(cand));
    serial = cand; accSerialDups++;
  }
  seenAccSerials.add(serial);

  let user = g('user') && !isJunk(g('user')) ? g('user') : '';
  let notes = g('notes');
  if (user && !resolvableName(user)) {
    notes = (notes ? notes + ' | ' : '') + 'Assigned to: ' + user;
    user = '';
    accUserBlanked++;
  }
  const loc = VALID_LOC.has(g('location')) ? g('location') : '';
  noteLoc(g('location'), g('sub_location'));

  const model = g('model_number');
  const mfr = g('manufacturer');
  accessories.push({
    name: [mfr, model, g('category')].filter(Boolean).join(' ').trim() || `Accessory ${serial}`,
    model_number: model,
    serial_number: serial,
    category: 'Accessory',
    manufacturer: mfr,
    location: loc,
    sub_location: loc && !isJunk(g('sub_location')) ? g('sub_location') : '',
    total_qty: '1',
    assigned_qty: user ? '1' : '',
    user,
    min_qty: '0',
    notes
  });
}
writeCsv('5_accessories.csv', ['name', 'model_number', 'serial_number', 'category', 'manufacturer',
  'location', 'sub_location', 'total_qty', 'assigned_qty', 'user', 'min_qty', 'notes'], accessories);

// ---------- 5. Locations + Sub-locations ----------
const locations = [...locSet].sort().map(name => ({
  name, address: '', city: CITY_FOR[name][0], country: CITY_FOR[name][1]
}));
writeCsv('1_locations.csv', ['name', 'address', 'city', 'country'], locations);
const subLocations = [...subLocSet.values()].sort((a, b) => (a.location + a.name).localeCompare(b.location + b.name))
  .map(s => ({ location: s.location, name: s.name, code: '', floor: '', room: '', notes: '' }));
writeCsv('2_sub_locations.csv', ['location', 'name', 'code', 'floor', 'room', 'notes'], subLocations);

console.log('Import-ready files written to', OUT);
console.log(`  1_locations.csv      ${locations.length} sites (derived from asset/accessory references; source name col held person names)`);
console.log(`  2_sub_locations.csv  ${subLocations.length} sub-locations`);
console.log(`  3_users.csv          ${users.length} users (${uSkipped} blank/#N/A skipped, ${uDups} duplicate emails skipped, status Allocated->active)`);
console.log(`  4_assets.csv         ${assets.length} assets (${aRealigned} rows realigned, ${aSerialDups} dup serials suffixed, ${aTagDups} dup tags cleared, ${aUserBlanked} unresolvable assignees kept as notes, ${aSkipped} rows w/o serial skipped)`);
console.log(`  5_accessories.csv    ${accessories.length} accessories (${accSerialDups} dup serials suffixed, ${accUserBlanked} unresolvable assignees noted, ${accSkipped} skipped)`);
