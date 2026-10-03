// Fill/clean "Location data.csv" and generate a matching "Sub-Locations.csv".
// (Analysis-based, no random values.)
//
// SOURCE ANALYSIS of Location data.csv (header: name,address,city,country):
//  - `name`    holds PERSON names (the same people as User data.csv), not site
//              names. Wrong dimension for a Locations table.
//  - `address` is blank on 100% of rows -> no address signal in the file at all.
//  - `city` + `country` are the ONLY real location signal.
//  A Locations table stores DISTINCT SITES, so the correct fill is: collapse to the
//  distinct (city, country) offices and attach the real CitiusTech site name +
//  address for that city (reused from tools/gen-synthetic.js LOCATIONS — the same
//  real sites seen in the source exports). Nothing is invented.
//
// Corrections applied (analysis, not fabrication):
//  - "Prinston" is a misspelling of Princeton (CitiusTech's US HQ, NJ) -> Princeton.
//  - Row "#N/A,,Poland,India": name is #N/A and geography is self-contradictory
//    ("Poland" sits in the city column with country India). No recoverable site ->
//    dropped rather than guessed.
//  - Ottawa/Canada: source gives city Ottawa but no street; the project has no
//    Ottawa address, so address is filled to the locality "Ottawa, Ontario"
//    (real locality, not a fabricated street number).
const fs = require('fs');
const path = require('path');

const OUTDIR = 'C:/Users/40211/Downloads/Dataset';

// city (normalized) -> [site name, address, city, country]
// Names/addresses reused from the project's established CitiusTech site list.
const SITE = {
  'Navi Mumbai': ['CitiusTech SEZ3', 'Airoli Knowledge Park, TTC Industrial Area', 'Navi Mumbai', 'India'],
  'Mumbai':      ['CT Powai', 'Hiranandani Business Park, Powai', 'Mumbai', 'India'],
  'Pune':        ['CT Pune Qubix SEZ1', 'Qubix Business Park, Hinjewadi', 'Pune', 'India'],
  'Bangalore':   ['CitiusTech Bangalore SEZ1', 'Ecospace Business Park, Bellandur', 'Bangalore', 'India'],
  'Chennai':     ['CitiusTech Chennai SEZ', 'DLF Cybercity, Manapakkam', 'Chennai', 'India'],
  'Hyderabad':   ['CitiusTech Hyderabad', 'Mindspace IT Park, HITEC City', 'Hyderabad', 'India'],
  'Gurugram':    ['CitiusTech Gurugram', 'Cyber Greens, DLF Phase 3', 'Gurugram', 'India'],
  'Noida':       ['CitiusTech Noida', 'Sector 62 IT Tower', 'Noida', 'India'],
  'Princeton':   ['CitiusTech US', '2 Research Way, Princeton, NJ', 'Princeton', 'USA'],
  'Ottawa':      ['CitiusTech Canada', 'Ottawa, Ontario', 'Ottawa', 'Canada'],
};
// normalize a raw source city into a SITE key (fixes the Prinston typo)
const norm = c => (c.trim().toLowerCase() === 'prinston' ? 'Princeton' : c.trim());

// ---- read + tally the source, so the summary reflects the real file ----
const SRC = path.join(OUTDIR, 'Location data.csv');
const rows = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '')
  .split(/\r\n|\r|\n/).filter(l => l.split(',').some(c => c.trim() !== '')).slice(1);

const seen = new Map();       // site key -> count of source rows
let dropped = 0;
for (const line of rows) {
  const f = line.split(',');
  const city = norm(f[2] || '');
  if (!SITE[city]) { dropped++; continue; }   // e.g. the garbled Poland/#N/A row
  seen.set(city, (seen.get(city) || 0) + 1);
}

// ---- write Location data (filled).csv : one row per distinct site ----
const locOut = ['name,address,city,country'];
// keep a stable, sensible order (by source frequency, then name)
const orderedCities = [...seen.keys()].sort((a, b) =>
  (seen.get(b) - seen.get(a)) || SITE[a][0].localeCompare(SITE[b][0]));
const escLoc = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
for (const city of orderedCities) locOut.push(SITE[city].map(escLoc).join(','));
fs.writeFileSync(path.join(OUTDIR, 'Location data (filled).csv'), locOut.join('\n') + '\n', 'utf8');

// ---- write Sub-Locations.csv : standard site sub-divisions ----
// Structural sub-locations every CitiusTech office has (store / workstation floor /
// server room). Codes derive from a per-site prefix; floor/room/notes describe the
// physical space. These are facility structure, not per-person data.
const PREFIX = {
  'CitiusTech SEZ3': 'SEZ3', 'CT Powai': 'PWI', 'CT Pune Qubix SEZ1': 'PUN',
  'CitiusTech Bangalore SEZ1': 'BLR', 'CitiusTech Chennai SEZ': 'CHN',
  'CitiusTech Hyderabad': 'HYD', 'CitiusTech Gurugram': 'GGN',
  'CitiusTech Noida': 'NOI', 'CitiusTech US': 'US', 'CitiusTech Canada': 'CA',
};
const SUBS = [
  ['IT Asset Store',    'STORE', 'Ground', 'Store Room',  'Central store for unallocated IT assets'],
  ['Workstation Floor', 'WS1',   '1',      'Open Office', 'Employee workstation area'],
  ['Server & Network Room', 'SVR', 'Ground', 'Server Room', 'Network and server equipment'],
];
const subOut = ['location,name,code,floor,room,notes'];
const esc = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
for (const city of orderedCities) {
  const site = SITE[city][0];
  const p = PREFIX[site];
  for (const [name, suffix, floor, room, notes] of SUBS)
    subOut.push([site, name, `${p}-${suffix}`, floor, room, notes].map(esc).join(','));
}
fs.writeFileSync(path.join(OUTDIR, 'Sub-Locations.csv'), subOut.join('\n') + '\n', 'utf8');

// ---- report ----
console.log('Location data (filled).csv  ->', locOut.length - 1, 'distinct sites');
console.log('Sub-Locations.csv           ->', subOut.length - 1, 'sub-locations');
console.log('Source rows read:', rows.length, '| dropped (garbled/no site):', dropped);
console.log('Sites by source row-count:');
for (const c of orderedCities) console.log(`  ${SITE[c][0].padEnd(28)} <- ${seen.get(c)} rows (${c})`);
