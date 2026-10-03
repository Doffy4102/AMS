// Fill missing values in "User data.csv" using logic derived from the data
// (no random values) and drop unusable rows. Writes "User data (filled).csv".
//
// Derived fill rules:
//  - role   (empty on every row) = "employee"  — the source carries no role/title
//        info; every listed person is standard staff (no admin markers), so the
//        base employee role applies uniformly.
//  - status ("Allocated" on every row) = "active" — "Allocated" is an
//        asset-allocation state, not a user-account state; a person holding an
//        allocated asset is an active employee.
// Cleaning (can't be filled without fabricating identities, so removed):
//  - fully-blank identity rows (no name AND no email) -> dropped
//  - rows whose name/email is "#N/A" -> dropped (no recoverable identity)
//  - duplicate people -> de-duplicated on email (case-insensitive), keep first
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/40211/Downloads/Dataset/User data.csv';
const OUT = path.join(path.dirname(SRC), 'User data (filled).csv');

const t = v => (v === null || v === undefined) ? '' : String(v).trim();
const isNA = v => t(v).toUpperCase() === '#N/A' || t(v) === '';

// No field in this file contains commas/quotes -> line/comma split is exact.
const lines = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '')
  .split(/\r\n|\r|\n/).filter(l => l.split(',').some(c => t(c) !== ''));
const header = lines[0].split(',').map(t);

const out = [header.join(',')];
const seenEmails = new Set();
let dropBlank = 0, dropNA = 0, dropDup = 0, filledRole = 0, mappedStatus = 0, kept = 0;

for (let i = 1; i < lines.length; i++) {
  const r = lines[i].split(',');
  const employee_id = t(r[0]);
  const name = t(r[1]);
  const email = t(r[2]);

  // drop rows we cannot fill without inventing an identity
  if (isNA(name) && isNA(email)) { dropBlank++; continue; }
  if (isNA(name) || isNA(email) || !email.includes('@')) { dropNA++; continue; }

  // de-duplicate on email
  const key = email.toLowerCase();
  if (seenEmails.has(key)) { dropDup++; continue; }
  seenEmails.add(key);

  const role = 'employee';       // filled
  filledRole++;
  const status = 'active';       // Allocated -> active
  mappedStatus++;
  kept++;

  out.push([employee_id, name, email, role, status].join(','));
}

fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log('Filled file written to:', OUT);
console.log(`Kept ${kept} users.`);
console.log(`Filled -> role: ${filledRole} (all "employee"), status: ${mappedStatus} (Allocated -> active)`);
console.log(`Dropped -> ${dropBlank} blank rows, ${dropNA} #N/A rows, ${dropDup} duplicate emails`);
