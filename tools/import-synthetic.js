// Imports the synthetic dataset through the running app's Import Center (in order).
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const DIR = path.join(__dirname, '..', 'sample-data', 'synthetic-citius');
let cookies = {};
const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
function sc(r) { (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(c => { const p = c.split(';')[0]; const i = p.indexOf('='); cookies[p.slice(0, i)] = p.slice(i + 1); }); }
async function get(p) { const r = await fetch(BASE + p, { headers: { Cookie: ch() }, redirect: 'manual' }); sc(r); return r; }
async function post(p, b) { const r = await fetch(BASE + p, { method: 'POST', headers: { Cookie: ch(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b).toString(), redirect: 'manual' }); sc(r); return r; }
async function csrfFrom(p) { const r = await get(p); const h = await r.text(); return (h.match(/name="_csrf" value="([^"]+)"/) || [])[1]; }

const ORDER = [
  ['locations', '1_locations.csv'],
  ['sub_locations', '2_sub_locations.csv'],
  ['users', '4_users.csv'],
  ['assets', '5_assets.csv'],
  ['accessories', '6_accessories.csv']
];

(async () => {
  let csrf = await csrfFrom('/login');
  await post('/login', { email: 'admin@hams.inc', password: 'password', _csrf: csrf });
  for (const [module, file] of ORDER) {
    const csvData = fs.readFileSync(path.join(DIR, file), 'utf8');
    csrf = await csrfFrom('/import');
    const pRes = await post('/import/preview', { _csrf: csrf, module, csv_paste: csvData });
    const pHtml = await pRes.text();
    const valid = (pHtml.match(/Valid<\/div>\s*<div[^>]*>(\d+)/) || [])[1] || '0';
    const errors = (pHtml.match(/Errors<\/div>\s*<div[^>]*>(\d+)/) || [])[1] || '0';
    csrf = await csrfFrom('/import');
    const eRes = await post('/import/execute', { _csrf: csrf });
    console.log(`${module.padEnd(14)} preview ${valid} valid / ${errors} errors -> execute ${eRes.status}`);
  }
})();
