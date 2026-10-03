// Fill missing values in "Accessaries data.csv" using logic derived from the
// data itself (no random values). Writes "Accessaries data (filled).csv".
//
// Derived fill rules (justified by analysis of the file):
//  - total_qty   = 1        every row has a UNIQUE serial_number => one physical unit
//  - assigned_qty= 1 | 0    1 when `user` is present (allocated), else 0 (in store)
//  - min_qty     = 0        units are individually serial-tracked assets, not a
//                           replenishable bulk pool, so no reorder threshold applies
//  - name (blank)= item description built from manufacturer + model_number
//                           (blank name occurs only on unassigned rows; assigned rows
//                            already carry the assignee name, matching `user` 30/30)
//  - notes       = factual allocation status derived from user/sub_location
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/40211/Downloads/Dataset/Accessaries data.csv';
const OUT = path.join(path.dirname(SRC), 'Accessaries data (filled).csv');

const t = v => (v === null || v === undefined) ? '' : String(v).trim();

// No field in this file contains commas/quotes, so a line/comma split is exact.
const lines = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '')
  .split(/\r\n|\r|\n/).filter(l => l.split(',').some(c => t(c) !== ''));
const header = lines[0].split(',').map(t);
const col = n => header.indexOf(n);
const C = {
  name: col('name'), model: col('model_number'), serial: col('serial_number'),
  category: col('category'), manufacturer: col('manufacturer'), location: col('location'),
  sub: col('sub_location'), total: col('total_qty'), assigned: col('assigned_qty'),
  user: col('user'), min: col('min_qty'), notes: col('notes')
};

// Build a clean item name: "Manufacturer Model" without duplicating the maker.
function itemName(manufacturer, model, category) {
  const mfr = t(manufacturer);
  const mdl = t(model);
  let base;
  if (!mdl) base = mfr;
  else if (mfr && mdl.toLowerCase().startsWith(mfr.toLowerCase())) base = mdl; // "Dell WH125", "EPOS SC60 USB ML"
  else base = (mfr ? mfr + ' ' : '') + mdl;                                     // "Sennheiser PC8-USB VOIP"
  base = base.replace(/\s+/g, ' ').trim();
  return category && !base.toLowerCase().includes(category.toLowerCase())
    ? `${base} ${category}` : base;                                            // append type for clarity
}

let filledName = 0, filledTotal = 0, filledAssigned = 0, filledMin = 0, filledNotes = 0;
const out = [header.join(',')];

for (let i = 1; i < lines.length; i++) {
  const r = lines[i].split(',');
  const g = j => t(r[j]);
  const user = g(C.user);

  // name
  if (!g(C.name)) { r[C.name] = itemName(g(C.manufacturer), g(C.model), g(C.category)); filledName++; }
  // total_qty
  if (!g(C.total)) { r[C.total] = '1'; filledTotal++; }
  // assigned_qty
  if (!g(C.assigned)) { r[C.assigned] = user ? '1' : '0'; filledAssigned++; }
  // min_qty
  if (!g(C.min)) { r[C.min] = '0'; filledMin++; }
  // notes
  if (!g(C.notes)) {
    r[C.notes] = user
      ? `Allocated to ${user}`
      : `Available in stock at ${g(C.sub) || g(C.location) || 'store'}`;
    filledNotes++;
  }

  // normalize the known trailing-space model ("WH1022 ")
  r[C.model] = g(C.model);
  out.push(r.map(t).join(','));
}

fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log('Filled file written to:', OUT);
console.log(`Rows: ${lines.length - 1}`);
console.log(`Cells filled -> name: ${filledName}, total_qty: ${filledTotal}, assigned_qty: ${filledAssigned}, min_qty: ${filledMin}, notes: ${filledNotes}`);
