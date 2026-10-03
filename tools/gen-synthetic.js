// Synthetic dataset generator for IT-HAMS.
// Models the correlation observed across three source files WITHOUT using any of
// their actual values:
//   HeadCount roster (people) --email/ctid--> Asset inventory --serial--> Intune MDM telemetry
// Produces IT-HAMS Import-Center CSVs under sample-data/synthetic-citius/.
// Everything (names, emails, serials, MACs, TPM ids) is fabricated.
const fs = require('fs');
const path = require('path');

// ---- deterministic RNG (seeded LCG) so re-runs are reproducible ----
let seed = 20260210;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;
const intBetween = (a, b) => a + Math.floor(rnd() * (b - a + 1));
function weighted(pairs) { // [[value, weight], ...]
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
}
function csv(rows) {
  return rows.map(r => r.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}
function dateISO(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date('2026-02-10T00:00:00Z'); d.setDate(d.getDate() - n); return d; }
function dateTime(d) { return d.toISOString().replace('T', ' ').slice(0, 19); }

const OUT = path.join(__dirname, '..', 'sample-data', 'synthetic-citius');
fs.mkdirSync(OUT, { recursive: true });

// ---- fabricated company ----
const DOMAIN = 'northwind-hls.example';

// ---- 1. Locations (real CitiusTech site names, as seen in the source exports) ----
const LOCATIONS = [
  ['CitiusTech SEZ3', 'Airoli Knowledge Park, TTC Industrial Area', 'Navi Mumbai', 'India'],
  ['CT Powai', 'Hiranandani Business Park, Powai', 'Mumbai', 'India'],
  ['CT Mindspace-1', 'Mindspace IT Park, Airoli', 'Navi Mumbai', 'India'],
  ['CT Mindspace-3', 'Mindspace IT Park, Airoli', 'Navi Mumbai', 'India'],
  ['CT Pune Qubix SEZ1', 'Qubix Business Park, Hinjewadi', 'Pune', 'India'],
  ['CT Pune (E) - EON', 'EON IT Park, Kharadi', 'Pune', 'India'],
  ['CitiusTech Bangalore SEZ1', 'Ecospace Business Park, Bellandur', 'Bangalore', 'India'],
  ['CT Bangalore SEZ', 'Ecoworld, Outer Ring Road', 'Bangalore', 'India'],
  ['CitiusTech Chennai SEZ', 'DLF Cybercity, Manapakkam', 'Chennai', 'India'],
  ['CitiusTech Hyderabad', 'Mindspace IT Park, HITEC City', 'Hyderabad', 'India'],
  ['Wilco Source Hyderabad', 'Raheja Mindspace, Madhapur', 'Hyderabad', 'India'],
  ['CitiusTech STPI', 'STPI Building, Mahape', 'Navi Mumbai', 'India'],
  ['CitiusTech Gurugram', 'Cyber Greens, DLF Phase 3', 'Gurugram', 'India'],
  ['CitiusTech Noida', 'Sector 62 IT Tower', 'Noida', 'India'],
  ['CitiusTech US', '2 Research Way', 'Princeton', 'USA'],
  ['CitiusTech Canada', '100 King Street West', 'Toronto', 'Canada'],
  ['CitiusTech United Kingdom', '1 Fore Street Avenue', 'London', 'United Kingdom']
];
const SUBLOCS = ['Ground Floor', '2nd Floor Wing A', '3rd Floor Wing B', '5th Floor', 'IT Store Room', 'Server Room'];

// ---- 2. Departments (org structure) ----
const DEPARTMENTS = [
  'Product & App Engineering', 'Cloud & Platform Engineering', 'Data & AI', 'Quality Engineering',
  'Infrastructure & IT Operations', 'Security & Compliance', 'HLS Delivery', 'Payer Delivery',
  'Provider Delivery', 'Program Management Office', 'People & Culture', 'Finance & Administration'
];
const DESIGNATIONS = ['Associate Engineer', 'Engineer', 'Senior Engineer', 'Lead Engineer - I', 'Lead Engineer - II',
  'Technical Architect', 'Engineering Manager', 'Delivery Manager', 'Principal Consultant', 'QA Analyst',
  'DevOps Engineer', 'Data Scientist', 'Scrum Master', 'Business Analyst', 'IT Systems Administrator'];
const EMP_TYPES = [['Employee', 8], ['Contractor', 2]];
const CLIENTS = ['Meridian Health Systems', 'BlueSpring Payer', 'Cardinal Provider Group', 'Helix Diagnostics',
  'Summit Care Network', 'Vantage Life Sciences', 'Internal / Bench'];
const PROJECTS = ['Claims Modernization', 'FHIR Interop Platform', 'Care Analytics Suite', 'Provider Portal 2.0',
  'Pharmacy Data Lake', 'Imaging AI Pilot', 'Bench / Unallocated'];

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan',
  'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Navya', 'Riya', 'Myra', 'Kiara',
  'James', 'Michael', 'David', 'Emily', 'Sarah', 'Jessica', 'Daniel', 'Laura', 'Robert', 'Grace',
  'Nikhil', 'Priya', 'Sneha', 'Karthik', 'Deepa', 'Rahul', 'Meera', 'Suresh', 'Fatima', 'Omar'];
const LAST = ['Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Menon', 'Rao', 'Gupta', 'Kulkarni',
  'Desai', 'Chowdhury', 'Banerjee', 'Bose', 'Mehta', 'Shah', 'Pillai', 'Krishnan', 'Joshi', 'Kapoor',
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Anderson'];

// ---- build employees ----
const NUM_EMP = 600;
const usedEmail = new Set();
const employees = [];
for (let i = 0; i < NUM_EMP; i++) {
  const first = pick(FIRST), last = pick(LAST);
  let base = `${first}.${last}`.toLowerCase();
  let email = `${base}@${DOMAIN}`, n = 2;
  while (usedEmail.has(email)) email = `${base}${n++}@${DOMAIN}`;
  usedEmail.add(email);
  const dept = pick(DEPARTMENTS);
  const loc = pick(LOCATIONS);
  const empType = weighted(EMP_TYPES);
  employees.push({
    ctid: 'NW' + String(100000 + i).slice(-6),
    name: `${first} ${last}`, email,
    dept, designation: pick(DESIGNATIONS), empType,
    location: loc[0], client: pick(CLIENTS), project: pick(PROJECTS),
    // IT-HAMS role: IT/Infra staff get elevated roles
    role: dept === 'Infrastructure & IT Operations'
      ? weighted([['it_admin', 3], ['asset_manager', 3], ['employee', 4]])
      : (dept === 'Security & Compliance' ? weighted([['asset_manager', 2], ['employee', 8]]) : 'employee'),
    status: weighted([['active', 92], ['pending', 4], ['suspended', 4]])
  });
}
// assign reporting heads (managers within same dept)
const managers = employees.filter(e => /Manager|Architect|Lead Engineer - II|Principal/.test(e.designation));
for (const e of employees) {
  const pool = managers.filter(m => m.dept === e.dept && m.email !== e.email);
  e.reporting_head = (pool.length ? pick(pool) : pick(managers.filter(m => m.email !== e.email) || managers)) || null;
}

// ---- 3. Asset catalog pools ----
const LAPTOPS = [
  ['Dell', 'Latitude 5450'], ['Dell', 'Latitude 7450'], ['Dell', 'Precision 3591'],
  ['Lenovo', 'ThinkPad T14 Gen 5'], ['Lenovo', 'ThinkPad X1 Carbon Gen 12'], ['Lenovo', 'ThinkPad L14 Gen 5'],
  ['HP', 'EliteBook 840 G11'], ['Apple', 'MacBook Pro 14 M3'], ['Apple', 'MacBook Air 13 M3']];
const DESKTOPS = [['Dell', 'OptiPlex 7020'], ['HP', 'ProDesk 600 G9'], ['Lenovo', 'ThinkCentre M90t']];
const THINCLIENTS = [['Dell', 'Wyse 5070'], ['HP', 't640 Thin Client']];
const MONITORS = [['Dell', 'P2725H'], ['Dell', 'U2723QE'], ['LG', '27UP650'], ['HP', 'E24 G5']];
const HEADSETS = [['Sennheiser', 'SC 660'], ['Jabra', 'Evolve2 65'], ['Plantronics', 'Voyager 4320'], ['Sennheiser', 'Adapt 660']];
const PHONES = [['Apple', 'iPhone 15'], ['Samsung', 'Galaxy S24'], ['OnePlus', 'Nord 4'], ['Motorola', 'Edge 50']];
const TABLETS = [['Apple', 'iPad 10th Gen'], ['Samsung', 'Galaxy Tab S9']];
const SERVERS = [['Dell', 'PowerEdge R760'], ['HP', 'ProLiant DL380 Gen11']];
const NETWORK = [['Cisco', 'Catalyst 9300'], ['Cisco', 'Meraki MR46 AP'], ['Fortinet', 'FortiGate 100F'], ['Cisco', 'Nexus 9300']];
const YUBIKEYS = [['Yubico', 'YubiKey 5C NFC']];

const OS_BUILDS = ['10.0.22631.4169', '10.0.22631.4317', '10.0.26100.2314', '10.0.19045.5011'];
const MAC_OS = ['14.5', '14.6.1', '15.0.1'];
const IOS = ['17.5.1', '17.6', '18.0'];
const ANDROID = ['13', '14', '15'];

function serial() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = ''; for (let i = 0; i < 7; i++) s += cs[Math.floor(rnd() * cs.length)];
  return 'NW' + s;
}
function mac() { let p = []; for (let i = 0; i < 6; i++) p.push(('0' + Math.floor(rnd() * 256).toString(16).toUpperCase()).slice(-2)); return p.join(':'); }
function imei() { let s = ''; for (let i = 0; i < 15; i++) s += Math.floor(rnd() * 10); return s; }

// asset category plan with weights (mirrors real fleet shape)
const PLAN = [
  ['Laptop', LAPTOPS, 700, 'computing'],
  ['Headphone', HEADSETS, 300, 'peripheral-personal'],
  ['HD Monitor', MONITORS, 180, 'peripheral-personal'],
  ['Desktop', DESKTOPS, 60, 'computing'],
  ['Thin Client', THINCLIENTS, 40, 'computing'],
  ['Mobile Device', PHONES, 80, 'mobile'],
  ['Tablet', TABLETS, 30, 'mobile'],
  ['Yubikey', YUBIKEYS, 60, 'peripheral-personal'],
  ['Server', SERVERS, 15, 'datacenter'],
  ['Network Device', NETWORK, 25, 'datacenter']
];

const assets = [];
let tagSeq = 1;
const usedSerial = new Set();
function newSerial() { let s; do { s = serial(); } while (usedSerial.has(s)); usedSerial.add(s); return s; }

for (const [category, pool, count, kind] of PLAN) {
  for (let i = 0; i < count; i++) {
    const [mfr, model] = pick(pool);
    const allocatable = kind !== 'datacenter';
    // datacenter items never assigned to a person; others allocated ~65%
    const allocated = allocatable && chance(0.85);
    const emp = allocated ? pick(employees.filter(e => e.status === 'active')) : null;
    const status = allocated ? 'assigned' : 'available';
    const purchase = daysAgo(intBetween(60, 1400));
    const warrantyYears = kind === 'datacenter' ? 5 : (mfr === 'Apple' ? 3 : 4);
    const warranty = new Date(purchase); warranty.setFullYear(warranty.getFullYear() + warrantyYears);
    const costMap = { Laptop: [900, 2600], Desktop: [700, 1400], 'Thin Client': [300, 550], 'HD Monitor': [180, 650],
      Headphone: [60, 320], 'Mobile Device': [400, 1300], Tablet: [350, 1100], Yubikey: [45, 70],
      Server: [6000, 12000], 'Network Device': [800, 6000] };
    const [lo, hi] = costMap[category] || [100, 500];
    const purchaseCost = intBetween(lo, hi);

    const cf = { import_source: 'SYNTH-CITIUS', asset_kind: kind };
    if (emp) {
      cf.assigned_email = emp.email; cf.assigned_user = emp.name; cf.ctid = emp.ctid;
      cf.department = emp.dept; cf.designation = emp.designation; cf.employee_type = emp.empType;
      cf.client = emp.client; cf.project = emp.project;
      if (emp.reporting_head) cf.reporting_head = emp.reporting_head.name;
    }
    // ---- Intune-style MDM telemetry correlated by serial+email (computing & mobile only) ----
    if ((kind === 'computing' || kind === 'mobile') && allocated) {
      cf.intune_managed = 'Yes';
      cf.mdm_serial = null; // set to serial below (same physical machine)
      cf.compliance = weighted([['Compliant', 92], ['Noncompliant', 4], ['InGracePeriod', 3], ['Not Evaluated', 1]]);
      cf.ownership = weighted([['Corporate', 8], ['Personal', 2]]);
      cf.azure_ad_join = kind === 'computing' ? weighted([['Azure AD joined', 7], ['Hybrid Azure AD joined', 3]]) : 'Azure AD registered';
      cf.encrypted = kind === 'computing' ? weighted([['True', 9], ['False', 1]]) : 'True';
      cf.enrollment_date = dateTime(daysAgo(intBetween(30, 1200)));
      cf.last_checkin = dateTime(daysAgo(intBetween(0, 6)));
      cf.wifi_mac = mac();
      cf.total_storage_gb = kind === 'computing' ? pick([256, 512, 1024]) : pick([128, 256, 512]);
      cf.free_storage_gb = Math.floor(cf.total_storage_gb * (0.2 + rnd() * 0.6));
      cf.primary_user_upn = emp.email;
      if (kind === 'computing') {
        if (mfr === 'Apple') { cf.os = 'macOS'; cf.os_version = pick(MAC_OS); cf.tpm_version = 'Apple T2/Secure Enclave'; }
        else { cf.os = 'Windows'; cf.os_version = pick(OS_BUILDS); cf.sku = 'Enterprise'; cf.tpm_version = '2.0'; cf.tpm_manufacturer = pick(['NTC', 'IFX', 'INTC', 'STM']); }
        cf.processor = mfr === 'Apple' ? pick(['Apple M3', 'Apple M3 Pro'])
          : pick(['Intel Core Ultra 7 165U', '13th Gen Intel Core i7-1355U', 'AMD Ryzen 7 PRO 7840U', '13th Gen Intel Core i5-1345U']);
        cf.ram_gb = pick([16, 16, 32, 32, 64]);
        cf.harddisk_type = 'SSD';
      } else { // mobile
        if (mfr === 'Apple') { cf.os = 'iOS'; cf.os_version = pick(IOS); }
        else { cf.os = 'Android'; cf.os_version = pick(ANDROID); }
        cf.imei = imei();
        cf.carrier = pick(['Airtel', 'Jio', 'Vodafone Idea', 'AT&T', 'Verizon', 'EE']);
      }
    }
    const s = newSerial();
    if (cf.intune_managed) cf.mdm_serial = s;

    const loc = emp ? emp.location : pick(LOCATIONS.map(l => l[0]));
    assets.push({
      asset_tag: 'FA-' + String(500000 + tagSeq++),
      name: `${mfr} ${model}`,
      serial: s,
      model, category,
      manufacturer: mfr,
      location: loc,
      sub_location: chance(0.5) ? pick(SUBLOCS) : '',
      status,
      purchase_date: dateISO(purchase),
      purchase_cost: purchaseCost,
      warranty_expiry: dateISO(warranty),
      user: emp ? emp.email : '',
      notes: kind === 'peripheral-personal' && chance(0.3) ? 'Adapter/accessory bundled' : '',
      cf
    });
  }
}

// ---- 4. Accessories (shared/bulk peripherals, quantity-based) ----
const ACCESSORIES = [
  ['Logitech MX Master 3S Mouse', 'Logitech', 'Accessory', 80, 30],
  ['Logitech MX Keys Keyboard', 'Logitech', 'Accessory', 70, 25],
  ['Dell WD19S USB-C Dock', 'Dell', 'Accessory', 60, 20],
  ['Lenovo USB-C Dock Gen2', 'Lenovo', 'Accessory', 45, 12],
  ['Logitech C920 Webcam', 'Logitech', 'Accessory', 50, 10],
  ['Anker 7-in-1 USB-C Hub', 'Anker', 'Accessory', 90, 24],
  ['Kensington Laptop Lock', 'Kensington', 'Accessory', 120, 40],
  ['Jabra Speak 750 Speakerphone', 'Jabra', 'Accessory', 20, 6]];

// ---- write CSVs ----
// locations
fs.writeFileSync(path.join(OUT, '1_locations.csv'),
  csv([['name', 'address', 'city', 'country'], ...LOCATIONS]));

// sub-locations (a couple per location)
const subRows = [['location', 'name', 'code', 'floor', 'room', 'notes']];
for (const [locName] of LOCATIONS) {
  const picks = [SUBLOCS[intBetween(0, 3)], 'IT Store Room'];
  for (const sname of [...new Set(picks)]) {
    subRows.push([locName, sname, sname.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase(), '', '', '']);
  }
}
fs.writeFileSync(path.join(OUT, '2_sub_locations.csv'), csv(subRows));

// departments (for reference / manual dept import — IT-HAMS users import resolves department by name)
fs.writeFileSync(path.join(OUT, '3_departments.csv'),
  csv([['name', 'cost_center'], ...DEPARTMENTS.map((d, i) => [d, 'CC-' + (100 + i)])]));

// employees -> users
fs.writeFileSync(path.join(OUT, '4_users.csv'),
  csv([['employee_id', 'name', 'email', 'role', 'status'],
    ...employees.map(e => [e.ctid, e.name, e.email, e.role, e.status])]));

// assets (first-class cols + cf_* telemetry)
const cfKeys = [...new Set(assets.flatMap(a => Object.keys(a.cf)))];
const assetHeader = ['asset_tag', 'name', 'serial_number', 'model_number', 'category', 'location', 'sub_location',
  'status', 'purchase_date', 'purchase_cost', 'warranty_expiry', 'user', 'notes', ...cfKeys.map(k => 'cf_' + k)];
const assetRows = [assetHeader];
for (const a of assets) {
  assetRows.push([a.asset_tag, a.name, a.serial, a.model, a.category, a.location, a.sub_location,
    a.status, a.purchase_date, a.purchase_cost, a.warranty_expiry, a.user, a.notes,
    ...cfKeys.map(k => a.cf[k] !== undefined && a.cf[k] !== null ? a.cf[k] : '')]);
}
fs.writeFileSync(path.join(OUT, '5_assets.csv'), csv(assetRows));

// accessories
const accRows = [['name', 'model_number', 'manufacturer', 'category', 'location', 'total_qty', 'assigned_qty', 'user', 'min_qty', 'notes']];
for (const [name, mfr, cat, total, assigned] of ACCESSORIES) {
  const holder = chance(0.6) ? pick(employees.filter(e => e.status === 'active')).email : '';
  accRows.push([name, '', mfr, cat, pick(LOCATIONS)[0], total, holder ? Math.min(assigned, total) : 0, holder, Math.floor(total * 0.15), '']);
}
fs.writeFileSync(path.join(OUT, '6_accessories.csv'), csv(accRows));

// ---- stats ----
const byCat = {};
for (const a of assets) byCat[a.category] = (byCat[a.category] || 0) + 1;
const managed = assets.filter(a => a.cf.intune_managed).length;
const allocated = assets.filter(a => a.status === 'assigned').length;
console.log('Synthetic dataset written to', OUT);
console.log('  locations:', LOCATIONS.length, '| sub-locations:', subRows.length - 1, '| departments:', DEPARTMENTS.length);
console.log('  employees(users):', employees.length);
console.log('  assets:', assets.length, '| allocated:', allocated, '| MDM-managed w/ telemetry:', managed);
console.log('  accessories:', ACCESSORIES.length);
console.log('  asset categories:', JSON.stringify(byCat));
console.log('  asset cf_ columns:', cfKeys.length);
