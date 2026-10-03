// Add the 12 components from the user's table into the Components module.
// - Categories RAM/SSD/Dock/Spare don't exist (only a generic "Component") and the
//   Import Center's resolver can't create categories/manufacturers, so we do it here.
// - 3 rows (Kingston/Crucial/Corsair DDR4/DDR5) already exist as seed data with
//   different serials/qty; the user's table is authoritative, so those are UPDATED
//   in place (matched by name) and the other 9 inserted -> exactly 12 rows, no dupes.
// - available_qty = total_qty (all in stock; no installed qty given).
const db = require('../src/core/db');

const CAT_COLOR = { RAM: '#f97316', SSD: '#22c55e', Dock: '#3b82f6', Spare: '#64748b' };
const ROWS = [
  ['Kingston DDR4 8GB 3200MHz',       'RAM',   'Kingston',        'RAM-KS-24001', 25, 5],
  ['Crucial DDR4 16GB 3200MHz',       'RAM',   'Crucial',         'RAM-CR-24002', 18, 4],
  ['Corsair DDR5 32GB 5600MHz',       'RAM',   'Corsair',         'RAM-CS-24003', 10, 2],
  ['Samsung 500GB SATA SSD',          'SSD',   'Samsung',         'SSD-SM-24001', 20, 5],
  ['WD Blue 1TB NVMe SSD',            'SSD',   'Western Digital', 'SSD-WD-24002', 15, 3],
  ['Crucial P3 Plus 2TB NVMe SSD',    'SSD',   'Crucial',         'SSD-CR-24003',  8, 2],
  ['Dell WD19 Docking Station',       'Dock',  'Dell',            'DCK-DE-24001', 12, 2],
  ['HP USB-C G5 Dock',                'Dock',  'HP',              'DCK-HP-24002', 10, 2],
  ['Lenovo ThinkPad USB-C Dock Gen2', 'Dock',  'Lenovo',          'DCK-LN-24003',  8, 2],
  ['Dell 65W Laptop Charger',         'Spare', 'Dell',            'SPR-DE-24001', 30, 5],
  ['Logitech K120 Keyboard',          'Spare', 'Logitech',        'SPR-LG-24002', 25, 5],
  ['Logitech M185 Wireless Mouse',    'Spare', 'Logitech',        'SPR-LG-24003', 40, 10],
];

(async () => {
  let inserted = 0, updated = 0;
  await db.tx(async t => {
    // component-type categories
    const catId = {};
    for (const name of [...new Set(ROWS.map(r => r[1]))]) {
      const ex = await t.get("SELECT id FROM asset_categories WHERE name = $1 AND type = 'component' AND deleted_at IS NULL", [name]);
      catId[name] = ex ? ex.id
        : await t.insert("INSERT INTO asset_categories (name, type, color) VALUES ($1,'component',$2)", [name, CAT_COLOR[name] || '#64748b']);
    }
    // manufacturers (reuse existing, create missing)
    const mfrId = {};
    for (const name of [...new Set(ROWS.map(r => r[2]))]) {
      const ex = await t.get('SELECT id FROM manufacturers WHERE name = $1 AND deleted_at IS NULL', [name]);
      mfrId[name] = ex ? ex.id : await t.insert('INSERT INTO manufacturers (name) VALUES ($1)', [name]);
    }
    // upsert components by name
    for (const [name, cat, mfr, serial, total, min] of ROWS) {
      const ex = await t.get('SELECT id FROM components WHERE name = $1 AND deleted_at IS NULL', [name]);
      if (ex) {
        await t.run(`UPDATE components SET category_id=$1, manufacturer_id=$2, serial_number=$3,
                     total_qty=$4, available_qty=$4, min_qty=$5, updated_at=now() WHERE id=$6`,
          [catId[cat], mfrId[mfr], serial, total, min, ex.id]);
        updated++;
      } else {
        await t.insert(`INSERT INTO components (name, category_id, manufacturer_id, serial_number,
                        total_qty, available_qty, min_qty)
                        VALUES ($1,$2,$3,$4,$5,$5,$6)`,
          [name, catId[cat], mfrId[mfr], serial, total, min]);
        inserted++;
      }
    }
  });
  console.log(`Components: ${inserted} inserted, ${updated} updated.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
