// Add the 10 consumables from the user's table into the Consumables module.
// Location model (per user's choice): a single parent location "Central IT Store"
// with the 7 physical storage bins as sub-locations under it; each consumable links
// to location_id (the store) + sub_location_id (its bin). Categories/manufacturers
// are created as needed (the Import Center resolver can't create them). Stock ->
// total_qty & remaining_qty (all in stock), Minimum -> min_qty.
const db = require('../src/core/db');

const PARENT = 'Central IT Store';
const CAT_COLOR = { Monitor: '#06b6d4', Supplies: '#f59e0b', Cables: '#14b8a6', Toner: '#8b5cf6', Batteries: '#22c55e' };
// storage bin -> code (floor left blank; room = bin name)
const BIN_CODE = {
  'IT Storage Room A': 'CIS-ITSR-A', 'Warehouse B': 'CIS-WH-B',
  'Supply Cabinet A': 'CIS-SC-A', 'Supply Cabinet B': 'CIS-SC-B',
  'Cable Rack A': 'CIS-CR-A', 'Cable Rack B': 'CIS-CR-B',
  'Printer Supplies Shelf': 'CIS-PSS',
};
const ROWS = [
  ['Dell P2422H 24" Monitor',        'Monitor',   'Dell',      'IT Storage Room A',      18, 5],
  ['LG 27MP400-B 27" Monitor',       'Monitor',   'LG',        'IT Storage Room A',      12, 3],
  ['Samsung S24R350 24" Monitor',    'Monitor',   'Samsung',   'Warehouse B',            10, 2],
  ['HP 65W Laptop Charger',          'Supplies',  'HP',        'Supply Cabinet A',       30, 8],
  ['HDMI Cable 2m',                  'Cables',    'UGREEN',    'Cable Rack A',           50, 15],
  ['USB-C to HDMI Adapter',          'Cables',    'Anker',     'Cable Rack B',           20, 5],
  ['HP 206A Black Toner',            'Toner',     'HP',        'Printer Supplies Shelf', 14, 4],
  ['Brother TN-760 Toner',           'Toner',     'Brother',   'Printer Supplies Shelf', 10, 3],
  ['AA Alkaline Battery (Pack of 4)','Batteries', 'Duracell',  'Supply Cabinet B',       40, 10],
  ['CR2032 Coin Cell Battery',       'Batteries', 'Panasonic', 'Supply Cabinet B',       35, 10],
];

(async () => {
  let inserted = 0, updated = 0;
  await db.tx(async t => {
    // parent location
    let loc = await t.get('SELECT id FROM locations WHERE name = $1 AND deleted_at IS NULL', [PARENT]);
    const locId = loc ? loc.id : await t.insert('INSERT INTO locations (name) VALUES ($1)', [PARENT]);

    // storage bins as sub-locations under the store
    const binId = {};
    for (const bin of [...new Set(ROWS.map(r => r[3]))]) {
      const ex = await t.get('SELECT id FROM sub_locations WHERE location_id = $1 AND name = $2 AND deleted_at IS NULL', [locId, bin]);
      binId[bin] = ex ? ex.id
        : await t.insert('INSERT INTO sub_locations (location_id, name, code, room, notes) VALUES ($1,$2,$3,$4,$5)',
            [locId, bin, BIN_CODE[bin] || null, bin, 'Consumable storage']);
    }
    // categories: names are GLOBALLY unique in asset_categories, so reuse an
    // existing category by name (e.g. "Monitor" already exists as an asset type);
    // create the rest as type='consumable'.
    const catId = {};
    for (const name of [...new Set(ROWS.map(r => r[1]))]) {
      const ex = await t.get('SELECT id FROM asset_categories WHERE name = $1 AND deleted_at IS NULL', [name]);
      catId[name] = ex ? ex.id
        : await t.insert("INSERT INTO asset_categories (name, type, color) VALUES ($1,'consumable',$2)", [name, CAT_COLOR[name] || '#64748b']);
    }
    // manufacturers (reuse/create)
    const mfrId = {};
    for (const name of [...new Set(ROWS.map(r => r[2]))]) {
      const ex = await t.get('SELECT id FROM manufacturers WHERE name = $1 AND deleted_at IS NULL', [name]);
      mfrId[name] = ex ? ex.id : await t.insert('INSERT INTO manufacturers (name) VALUES ($1)', [name]);
    }
    // upsert consumables by name
    for (const [name, cat, mfr, bin, stock, min] of ROWS) {
      const ex = await t.get('SELECT id FROM consumables WHERE name = $1 AND deleted_at IS NULL', [name]);
      if (ex) {
        await t.run(`UPDATE consumables SET category_id=$1, manufacturer_id=$2, location_id=$3, sub_location_id=$4,
                     total_qty=$5, remaining_qty=$5, min_qty=$6, updated_at=now() WHERE id=$7`,
          [catId[cat], mfrId[mfr], locId, binId[bin], stock, min, ex.id]);
        updated++;
      } else {
        await t.insert(`INSERT INTO consumables (name, category_id, manufacturer_id, location_id, sub_location_id,
                        total_qty, remaining_qty, min_qty) VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
          [name, catId[cat], mfrId[mfr], locId, binId[bin], stock, min]);
        inserted++;
      }
    }
  });
  console.log(`Consumables: ${inserted} inserted, ${updated} updated.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
