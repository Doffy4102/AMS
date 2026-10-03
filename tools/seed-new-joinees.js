// Seed 5 synthetic new joinees joining TODAY for the New Joinee onboarding
// section. Follows the existing users schema so joiners integrate with every
// other tab: each joinee gets a users row (role 'employee', status 'pending'
// until onboarding assets are allocated) plus a new_joinees row carrying the
// portal fields (employee id, location, employment status, DOJ, designation).
//
// Synthetic values correlate with existing data:
//  - employee_id: numeric, continuing the existing 5-digit series (max 78292)
//  - email: firstname.lastname@citiustech.com like the imported directory
//  - location_id: real rows from the locations table
// Idempotent: a joinee is skipped if its employee_id already exists.
const bcrypt = require('bcryptjs');
const db = require('../src/core/db');

const JOINEES = [
  { employee_id: '80001', name: 'Aarav Deshmukh', designation: 'Fresher',
    employment_status: 'Employee', location: 'CT Powai' },
  { employee_id: '80002', name: 'Sneha Kulkarni', designation: 'Engineer',
    employment_status: 'Employee', location: 'CT Pune Qubix SEZ1' },
  { employee_id: '80003', name: 'Rohan Iyer', designation: 'Consultant',
    employment_status: 'Contractor', location: 'CitiusTech Bangalore SEZ1' },
  { employee_id: '80004', name: 'Priya Venkatesan', designation: 'AVP',
    employment_status: 'Employee', location: 'CitiusTech Hyderabad' },
  { employee_id: '80005', name: 'Vikram Malhotra', designation: 'Senior Director',
    employment_status: 'Employee', location: 'CitiusTech Chennai SEZ' }
];

function emailFor(name) {
  return name.toLowerCase().split(/\s+/).join('.') + '@citiustech.com';
}

(async () => {
  const password = await bcrypt.hash('Welcome@' + new Date().getFullYear(), 10);
  let created = 0, skipped = 0;

  for (const j of JOINEES) {
    const exists = await db.get(
      'SELECT 1 FROM users WHERE employee_id = $1 UNION SELECT 1 FROM new_joinees WHERE employee_id = $1',
      [j.employee_id]);
    if (exists) { console.log(`~ ${j.employee_id} ${j.name} (already exists)`); skipped++; continue; }

    const loc = await db.get('SELECT id FROM locations WHERE name = $1', [j.location]);
    const email = emailFor(j.name);

    await db.tx(async t => {
      const userId = await t.insert(
        `INSERT INTO users (uuid, employee_id, name, email, password, role, status, location_id)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'employee', 'pending', $5)`,
        [j.employee_id, j.name, email, password, loc ? loc.id : null]);
      await t.run(
        `INSERT INTO new_joinees (user_id, employee_id, name, location_id,
                                  employment_status, date_of_joining, designation)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6)`,
        [userId, j.employee_id, j.name, loc ? loc.id : null, j.employment_status, j.designation]);
    });
    console.log(`+ ${j.employee_id} ${j.name} — ${j.designation}, ${j.employment_status}, ${j.location}`);
    created++;
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
