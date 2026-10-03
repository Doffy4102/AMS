// Fill missing values in "Asset hardware data.csv" using logic derived from the
// data itself (no random values), fix one comma-shifted row, and remove Headphone
// rows. Writes "Asset hardware data (filled).csv".
//
// Derived fill rules (justified by analysis):
//  - name (blank on 196 rows) = model_number  — the populated names are the
//        assignee (= `user` on 315/315 matched rows); the blank ones are
//        unallocated devices with no person, so the device's own model is its name.
//  - notes (empty on all rows) = factual allocation status derived from `user`:
//        "Allocated to {user}"  |  "Unallocated - in stock at {sub_location}"
//  - user (blank on 196 rows) = LEFT EMPTY on purpose. An unallocated device has
//        no assignee; inventing one would be fabricated data.
//  Comma-shift fix: one model_number ("P1 Gen 7 (Type 21KV, 21KW) ...") contains a
//        comma, splitting that row into 14 fields; the overflow is merged back into
//        model_number and the field is quoted on output.
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/40211/Downloads/Dataset/Asset hardware data.csv';
const OUT = path.join(path.dirname(SRC), 'Asset hardware data (filled).csv');

const t = v => (v === null || v === undefined) ? '' : String(v).trim();
const COLS = 13;
const IDX = { name: 1, serial: 2, model: 3, category: 4, location: 5, sub: 6, status: 7, user: 11, notes: 12 };

// Split on commas; if a row has extra fields, the surplus commas belong to
// model_number (col 3) — merge them back with a comma.
function parseRow(line) {
  const f = line.split(',');
  if (f.length <= COLS) return f.concat(Array(COLS - f.length).fill(''));
  const overflow = f.length - COLS;
  return f.slice(0, IDX.model)
    .concat([f.slice(IDX.model, IDX.model + overflow + 1).join(',')])
    .concat(f.slice(IDX.model + overflow + 1));
}

function csvEscape(v) {
  const s = t(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const lines = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '')
  .split(/\r\n|\r|\n/).filter(l => l.split(',').some(c => t(c) !== ''));
const header = lines[0].split(',').map(t);

const out = [header.join(',')];
let removedHeadphones = 0, filledName = 0, filledNotes = 0, realigned = 0, keptUnassigned = 0;

for (let i = 1; i < lines.length; i++) {
  const raw = lines[i].split(',');
  if (raw.length !== COLS) realigned++;
  const r = parseRow(lines[i]).map(t);

  // remove headphones
  if (r[IDX.category].toLowerCase() === 'headphone') { removedHeadphones++; continue; }

  const user = r[IDX.user];

  // name
  if (!r[IDX.name]) { r[IDX.name] = r[IDX.model]; filledName++; }
  // user stays as-is (blank = unallocated); count them
  if (!user) keptUnassigned++;
  // notes
  if (!r[IDX.notes]) {
    r[IDX.notes] = user
      ? `Allocated to ${user}`
      : `Unallocated - in stock at ${r[IDX.sub] || r[IDX.location] || 'store'}`;
    filledNotes++;
  }

  out.push(r.map(csvEscape).join(','));
}

fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log('Filled file written to:', OUT);
console.log(`Rows out: ${out.length - 1} (removed ${removedHeadphones} Headphone rows)`);
console.log(`Realigned comma-shifted rows: ${realigned}`);
console.log(`Filled -> name: ${filledName}, notes: ${filledNotes}`);
console.log(`User left blank (unallocated devices, not fabricated): ${keptUnassigned}`);
