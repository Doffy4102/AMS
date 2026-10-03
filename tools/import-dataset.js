// Import the prepared Dataset CSVs through the app's Import Center (HTTP).
// Order matters: locations -> sub_locations -> users -> assets -> accessories.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const DIR = path.join(__dirname, '..', 'sample-data', 'import-ready');

let cookies = {};
const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
function sc(res) {
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach(c => {
    const p = c.split(';')[0]; const i = p.indexOf('=');
    cookies[p.slice(0, i)] = p.slice(i + 1);
  });
}
async function get(p) { const r = await fetch(BASE + p, { headers: { Cookie: ch() }, redirect: 'manual' }); sc(r); return r; }
async function post(p, b) {
  const r = await fetch(BASE + p, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: ch(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(b).toString()
  });
  sc(r); return r;
}
async function csrfFrom(p) {
  const r = await get(p); const h = await r.text();
  return (h.match(/name="_csrf" value="([^"]+)"/) || [])[1];
}

const ORDER = [
  ['locations', '1_locations.csv'],
  ['sub_locations', '2_sub_locations.csv'],
  ['users', '3_users.csv'],
  ['assets', '4_assets.csv'],
  ['accessories', '5_accessories.csv']
];

(async () => {
  let csrf = await csrfFrom('/login');
  await post('/login', { email: 'admin@hams.inc', password: 'password', _csrf: csrf });

  for (const [module, file] of ORDER) {
    const csv = fs.readFileSync(path.join(DIR, file), 'utf8');
    csrf = await csrfFrom('/import');
    const pRes = await post('/import/preview', { _csrf: csrf, module, csv_paste: csv });
    const pHtml = await pRes.text();
    const valid = (pHtml.match(/Valid<\/div>\s*<div[^>]*>(\d+)/) || [])[1] || '0';
    const errors = (pHtml.match(/Errors<\/div>\s*<div[^>]*>(\d+)/) || [])[1] || '0';
    csrf = await csrfFrom('/import');
    const eRes = await post('/import/execute', { _csrf: csrf });
    console.log(`${module.padEnd(14)} preview: ${valid} valid / ${errors} errors -> executed (${eRes.status})`);
    if (errors !== '0') {
      const errRows = [...pHtml.matchAll(/<div class="text-xs text-rose-400">([^<]+)<\/div>/g)].map(m => m[1]).slice(0, 5);
      for (const e of errRows) console.log('    issue:', e);
    }
  }
  console.log('\nDone.');
})();
