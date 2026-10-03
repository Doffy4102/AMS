// Port of CatalogService: inventory-setup catalog types (hard deletes).
const db = require('../core/db');
const audit = require('./auditService');
const Paginator = require('../core/paginator');
const { validate } = require('../core/validator');
const { nullableId, HttpError, trimStr, intOr } = require('../core/helpers');

const TABLES = {
  categories: 'asset_categories',
  manufacturers: 'manufacturers',
  suppliers: 'suppliers',
  locations: 'locations',
  'sub-locations': 'sub_locations',
  'status-labels': 'status_labels',
  models: 'asset_models',
  'custom-fields': 'custom_fields',
  'custom-fieldsets': 'custom_fieldsets'
};

const PAGE_META = {
  categories: ['Categories', 'Define the inventory classes that drive acceptance rules, reporting, and future accessory/consumable modules.'],
  models: ['Asset Models', 'Group common hardware under model records with manufacturer, category, warranty, and lifecycle defaults.'],
  manufacturers: ['Manufacturers', 'Track device makers and support references for procurement and warranty workflows.'],
  suppliers: ['Suppliers', 'Maintain vendor contact details used by purchase and repair records.'],
  locations: ['Locations', 'Manage offices, storage rooms, and deployment sites for asset accountability.'],
  'sub-locations': ['Sub-Locations', 'Define rooms, floors, or zones within parent locations for granular asset tracking.'],
  'status-labels': ['Status Labels', 'Control lifecycle labels such as Ready to Deploy, Deployed, In Repair, Lost, and Retired.'],
  'custom-fields': ['Custom Fields', 'Create reusable fields such as Hostname, CPU, RAM, License Owner, or Warranty Notes.'],
  'custom-fieldsets': ['Custom Fieldsets', 'Group fields and attach them to hardware assets, accessories, components, licenses, kits, or specific categories.']
};

function resolveTable(type) {
  const table = TABLES[type];
  if (!table) throw new HttpError(`Unknown catalog type: ${type}`, 400);
  return table;
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

async function fetchFieldsets() {
  const rows = await db.query(
    `SELECT fs.*, COUNT(DISTINCT cff.field_id)::int AS fields_count,
            STRING_AGG(DISTINCT cfm.module_key, ',') AS modules,
            STRING_AGG(DISTINCT cff.field_id::text, ',') AS field_ids_csv
     FROM custom_fieldsets fs
     LEFT JOIN custom_fieldset_field cff ON cff.fieldset_id = fs.id
     LEFT JOIN custom_fieldset_module cfm ON cfm.fieldset_id = fs.id
     GROUP BY fs.id ORDER BY fs.name ASC`);
  for (const r of rows) {
    r.field_ids = r.field_ids_csv ? r.field_ids_csv.split(',').map(Number) : [];
    r.module_keys = r.modules ? r.modules.split(',').map(s => s.trim()).filter(Boolean) : ['assets'];
    if (!r.module_keys.length) r.module_keys = ['assets'];
  }
  return rows;
}

async function all() {
  const [categories, manufacturers, suppliers, locations, subLocations, statusLabels, models, cfields, cfieldsets] = await Promise.all([
    db.query('SELECT * FROM asset_categories ORDER BY name ASC'),
    db.query('SELECT * FROM manufacturers ORDER BY name ASC'),
    db.query('SELECT * FROM suppliers ORDER BY name ASC'),
    db.query('SELECT * FROM locations ORDER BY name ASC'),
    db.query(`SELECT sl.*, l.name AS location_name FROM sub_locations sl
              LEFT JOIN locations l ON sl.location_id = l.id ORDER BY l.name, sl.name LIMIT 5000`),
    db.query('SELECT * FROM status_labels ORDER BY name ASC'),
    db.query(`SELECT am.*, m.name AS manufacturer_name, ac.name AS category_name FROM asset_models am
              LEFT JOIN manufacturers m ON am.manufacturer_id = m.id
              LEFT JOIN asset_categories ac ON am.category_id = ac.id ORDER BY am.name ASC`),
    db.query('SELECT * FROM custom_fields ORDER BY name ASC'),
    fetchFieldsets()
  ]);
  return {
    categories, manufacturers, suppliers, locations, sub_locations: subLocations,
    status_labels: statusLabels, models, custom_fields: cfields, custom_fieldsets: cfieldsets
  };
}

async function overviewCards() {
  const refs = await all();
  const dept = await db.get('SELECT COUNT(*)::int AS c FROM departments');
  return [
    { title: 'Asset Models', type: 'models', icon: 'layers-3', count: refs.models.length, description: PAGE_META.models[1] },
    { title: 'Categories', type: 'categories', icon: 'tags', count: refs.categories.length, description: PAGE_META.categories[1] },
    { title: 'Custom Fields', type: 'custom-fields', icon: 'binary', count: refs.custom_fields.length, description: PAGE_META['custom-fields'][1] },
    { title: 'Fieldsets', type: 'custom-fieldsets', icon: 'layout-grid', count: refs.custom_fieldsets.length, description: PAGE_META['custom-fieldsets'][1] },
    { title: 'Manufacturers', type: 'manufacturers', icon: 'factory', count: refs.manufacturers.length, description: PAGE_META.manufacturers[1] },
    { title: 'Suppliers', type: 'suppliers', icon: 'truck', count: refs.suppliers.length, description: PAGE_META.suppliers[1] },
    { title: 'Locations', type: 'locations', icon: 'map-pin', count: refs.locations.length, description: PAGE_META.locations[1] },
    { title: 'Status Labels', type: 'status-labels', icon: 'badge-check', count: refs.status_labels.length, description: PAGE_META['status-labels'][1] },
    { title: 'Departments', type: 'departments', icon: 'building-2', count: dept.c, description: 'Organizational departments with managers and cost centers.' }
  ];
}

async function page(type, pageNum = 1, perPage = 15, filters = {}) {
  const table = resolveTable(type);
  const meta = PAGE_META[type];
  if (!meta) throw new HttpError('Unknown inventory setup page', 404);
  const search = filters.search || '';

  let countSql, fetchSql, params = [];
  if (type === 'models') {
    if (search) params.push(`%${search}%`);
    const where = search ? 'WHERE am.name ILIKE $1' : '';
    countSql = `SELECT COUNT(*)::int AS c FROM asset_models am ${where}`;
    fetchSql = `SELECT am.*, m.name AS manufacturer_name, ac.name AS category_name FROM asset_models am
                LEFT JOIN manufacturers m ON am.manufacturer_id = m.id
                LEFT JOIN asset_categories ac ON am.category_id = ac.id ${where} ORDER BY am.name ASC`;
  } else if (type === 'sub-locations') {
    if (search) { params.push(`%${search}%`); }
    const where = search ? 'WHERE (sl.name ILIKE $1 OR sl.code ILIKE $1 OR l.name ILIKE $1)' : '';
    countSql = `SELECT COUNT(*)::int AS c FROM sub_locations sl LEFT JOIN locations l ON sl.location_id = l.id ${where}`;
    fetchSql = `SELECT sl.*, l.name AS location_name FROM sub_locations sl
                LEFT JOIN locations l ON sl.location_id = l.id ${where} ORDER BY l.name, sl.name`;
  } else if (type === 'custom-fieldsets') {
    const items = await fetchFieldsets();
    const filtered = search ? items.filter(x => x.name.toLowerCase().includes(search.toLowerCase())) : items;
    const paginator = new Paginator(filtered.length, perPage, pageNum);
    return {
      type, title: meta[0], description: meta[1],
      items: filtered.slice(paginator.offset, paginator.offset + perPage),
      references: await all(), paginator
    };
  } else {
    if (search) params.push(`%${search}%`);
    const where = search ? 'WHERE name ILIKE $1' : '';
    countSql = `SELECT COUNT(*)::int AS c FROM ${table} ${where}`;
    fetchSql = `SELECT * FROM ${table} ${where} ORDER BY name ASC`;
  }

  const totalRow = await db.get(countSql, params);
  const paginator = new Paginator(totalRow.c, perPage, pageNum);
  const items = await db.query(`${fetchSql} LIMIT ${perPage} OFFSET ${paginator.offset}`, params);
  return { type, title: meta[0], description: meta[1], items, references: await all(), paginator };
}

async function validateData(type, data) {
  const rules = { name: 'required|max:255' };
  if (type === 'suppliers') { rules.email = 'email|max:255'; rules.phone = 'max:50'; }
  const v = validate(data, rules);
  if (v.fails) throw new HttpError(v.firstError, 422);
}

async function create(type, data, user) {
  resolveTable(type);
  await validateData(type, data);
  const userId = user ? user.id : null;
  let id = null;

  switch (type) {
    case 'categories':
      id = await db.insert(
        'INSERT INTO asset_categories (name, type, color, requires_acceptance, fieldset_id) VALUES ($1,$2,$3,$4,$5)',
        [trimStr(data.name), data.type || 'asset', data.color || '#3b82f6',
          data.requires_acceptance !== undefined, nullableId(data.fieldset_id)]);
      break;
    case 'manufacturers':
      id = await db.insert('INSERT INTO manufacturers (name, url, support_url) VALUES ($1,$2,$3)',
        [trimStr(data.name), trimStr(data.url), trimStr(data.support_url)]);
      break;
    case 'suppliers':
      id = await db.insert('INSERT INTO suppliers (name, contact_name, email, phone, address) VALUES ($1,$2,$3,$4,$5)',
        [trimStr(data.name), trimStr(data.contact_name), trimStr(data.email), trimStr(data.phone), trimStr(data.address)]);
      break;
    case 'locations':
      id = await db.insert('INSERT INTO locations (name, address, city, country) VALUES ($1,$2,$3,$4)',
        [trimStr(data.name), trimStr(data.address), trimStr(data.city), trimStr(data.country)]);
      break;
    case 'sub-locations':
      id = await db.insert('INSERT INTO sub_locations (location_id, name, code, floor, room, notes) VALUES ($1,$2,$3,$4,$5,$6)',
        [intOr(data.location_id, 0), trimStr(data.name), trimStr(data.code), trimStr(data.floor), trimStr(data.room), trimStr(data.notes)]);
      break;
    case 'status-labels':
      id = await db.insert('INSERT INTO status_labels (name, type, color) VALUES ($1,$2,$3)',
        [trimStr(data.name), data.type || 'deployable', data.color || '#3b82f6']);
      break;
    case 'models':
      id = await db.insert(
        'INSERT INTO asset_models (name, model_number, manufacturer_id, category_id, default_warranty_months, eol_months) VALUES ($1,$2,$3,$4,$5,$6)',
        [trimStr(data.name), trimStr(data.model_number), nullableId(data.manufacturer_id),
          nullableId(data.category_id), intOr(data.default_warranty_months, 12), nullableId(data.eol_months)]);
      break;
    case 'custom-fields': {
      const fieldKey = trimStr(data.field_key) || slugify(data.name);
      id = await db.insert(
        'INSERT INTO custom_fields (name, field_key, field_type, options, is_required) VALUES ($1,$2,$3,$4,$5)',
        [trimStr(data.name), fieldKey.toLowerCase(), data.field_type || 'text',
          trimStr(data.options) || null, data.is_required !== undefined]);
      break;
    }
    case 'custom-fieldsets': {
      let moduleKeys = data.module_keys || [data.module_key || 'assets'];
      if (!Array.isArray(moduleKeys)) moduleKeys = [moduleKeys];
      id = await db.tx(async t => {
        const fsId = await t.insert(
          'INSERT INTO custom_fieldsets (name, module_key, description) VALUES ($1,$2,$3)',
          [trimStr(data.name), moduleKeys[0] || 'assets', trimStr(data.description)]);
        let rank = 1;
        let fieldIds = data.field_ids || [];
        if (!Array.isArray(fieldIds)) fieldIds = [fieldIds];
        for (const fid of fieldIds) {
          if (fid === '') continue;
          await t.run('INSERT INTO custom_fieldset_field (fieldset_id, field_id, order_rank) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [fsId, parseInt(fid, 10), rank++]);
        }
        for (const mk of moduleKeys) {
          await t.run('INSERT INTO custom_fieldset_module (fieldset_id, module_key, category_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [fsId, mk, mk === 'assets' ? nullableId(data.category_id) : null]);
        }
        return fsId;
      });
      break;
    }
  }

  if (id) {
    await audit.log(userId, 'CATALOG_CREATED', `Created ${type}: ${trimStr(data.name)}`);
  }
  return id;
}

async function getCreatedRecord(type, id, data) {
  const cols = {
    categories: 'id, name, type, color',
    models: 'id, name, model_number',
    manufacturers: 'id, name',
    suppliers: 'id, name, email, phone',
    locations: 'id, name, address, city',
    'sub-locations': 'id, name, code, floor, room',
    'status-labels': 'id, name, type, color'
  };
  if (cols[type]) {
    const table = TABLES[type];
    return db.get(`SELECT ${cols[type]} FROM ${table} WHERE id = $1`, [id]);
  }
  return { id, name: data.name || '' };
}

async function update(type, id, data, user) {
  const table = resolveTable(type);
  await validateData(type, data);
  const userId = user ? user.id : null;

  switch (type) {
    case 'categories':
      await db.run('UPDATE asset_categories SET name=$1, type=$2, color=$3, requires_acceptance=$4, fieldset_id=$5 WHERE id=$6',
        [trimStr(data.name), data.type || 'asset', data.color || '#3b82f6', data.requires_acceptance !== undefined, nullableId(data.fieldset_id), id]);
      break;
    case 'manufacturers':
      await db.run('UPDATE manufacturers SET name=$1, url=$2, support_url=$3 WHERE id=$4',
        [trimStr(data.name), trimStr(data.url), trimStr(data.support_url), id]);
      break;
    case 'suppliers':
      await db.run('UPDATE suppliers SET name=$1, contact_name=$2, email=$3, phone=$4, address=$5 WHERE id=$6',
        [trimStr(data.name), trimStr(data.contact_name), trimStr(data.email), trimStr(data.phone), trimStr(data.address), id]);
      break;
    case 'locations':
      await db.run('UPDATE locations SET name=$1, address=$2, city=$3, country=$4 WHERE id=$5',
        [trimStr(data.name), trimStr(data.address), trimStr(data.city), trimStr(data.country), id]);
      break;
    case 'sub-locations':
      await db.run('UPDATE sub_locations SET location_id=$1, name=$2, code=$3, floor=$4, room=$5, notes=$6 WHERE id=$7',
        [intOr(data.location_id, 0), trimStr(data.name), trimStr(data.code), trimStr(data.floor), trimStr(data.room), trimStr(data.notes), id]);
      break;
    case 'status-labels':
      await db.run('UPDATE status_labels SET name=$1, type=$2, color=$3 WHERE id=$4',
        [trimStr(data.name), data.type || 'deployable', data.color || '#3b82f6', id]);
      break;
    case 'models':
      await db.run('UPDATE asset_models SET name=$1, model_number=$2, manufacturer_id=$3, category_id=$4, default_warranty_months=$5, eol_months=$6 WHERE id=$7',
        [trimStr(data.name), trimStr(data.model_number), nullableId(data.manufacturer_id), nullableId(data.category_id), intOr(data.default_warranty_months, 12), nullableId(data.eol_months), id]);
      break;
    case 'custom-fields':
      await db.run('UPDATE custom_fields SET name=$1, field_type=$2, options=$3, is_required=$4 WHERE id=$5',
        [trimStr(data.name), data.field_type || 'text', trimStr(data.options) || null, data.is_required !== undefined, id]);
      break;
    case 'custom-fieldsets': {
      let moduleKeys = data.module_keys || [data.module_key || 'assets'];
      if (!Array.isArray(moduleKeys)) moduleKeys = [moduleKeys];
      await db.tx(async t => {
        await t.run('UPDATE custom_fieldsets SET name=$1, description=$2 WHERE id=$3',
          [trimStr(data.name), trimStr(data.description), id]);
        await t.run('DELETE FROM custom_fieldset_field WHERE fieldset_id=$1', [id]);
        let rank = 1;
        let fieldIds = data.field_ids || [];
        if (!Array.isArray(fieldIds)) fieldIds = [fieldIds];
        for (const fid of fieldIds) {
          if (fid === '') continue;
          await t.run('INSERT INTO custom_fieldset_field (fieldset_id, field_id, order_rank) VALUES ($1,$2,$3)',
            [id, parseInt(fid, 10), rank++]);
        }
        await t.run('DELETE FROM custom_fieldset_module WHERE fieldset_id=$1', [id]);
        for (const mk of moduleKeys) {
          await t.run('INSERT INTO custom_fieldset_module (fieldset_id, module_key, category_id) VALUES ($1,$2,$3)',
            [id, mk, mk === 'assets' ? nullableId(data.category_id) : null]);
        }
      });
      break;
    }
  }

  await audit.log(userId, 'CATALOG_UPDATED', `Updated ${type} #${id}: ${trimStr(data.name)}`);
  return true;
}

async function remove(type, id, user) {
  const table = resolveTable(type);
  await db.run(`DELETE FROM ${table} WHERE id = $1`, [id]);
  await audit.log(user ? user.id : null, 'CATALOG_DELETED', `Deleted ${type} record #${id}.`);
  return true;
}

async function bulkDelete(type, ids, user) {
  const table = resolveTable(type);
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length) return 0;
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const res = await db.run(`DELETE FROM ${table} WHERE id IN (${ph})`, ids);
  if (res.rowCount > 0) {
    await audit.log(user ? user.id : null, 'CATALOG_BULK_DELETED',
      `Bulk deleted ${res.rowCount} ${type} record(s). IDs: ${ids.join(',')}`);
  }
  return res.rowCount;
}

// Catalog API search (underscore slugs)
async function search(type, q) {
  const like = `%${q}%`;
  const hasQ = q !== '';
  switch (type) {
    case 'categories':
      return db.query(`SELECT id, name, type, color FROM asset_categories ${hasQ ? 'WHERE name ILIKE $1' : ''} ORDER BY name LIMIT 100`, hasQ ? [like] : []);
    case 'models':
      return db.query(
        `SELECT am.id, am.name, am.model_number, m.name AS manufacturer_name FROM asset_models am
         LEFT JOIN manufacturers m ON am.manufacturer_id = m.id
         ${hasQ ? 'WHERE (am.name ILIKE $1 OR am.model_number ILIKE $1 OR m.name ILIKE $1)' : ''} ORDER BY am.name LIMIT 100`,
        hasQ ? [like] : []);
    case 'manufacturers':
      return db.query(`SELECT id, name FROM manufacturers ${hasQ ? 'WHERE name ILIKE $1' : ''} ORDER BY name LIMIT 100`, hasQ ? [like] : []);
    case 'suppliers':
      return db.query(`SELECT id, name, email, phone FROM suppliers ${hasQ ? 'WHERE (name ILIKE $1 OR email ILIKE $1)' : ''} ORDER BY name LIMIT 100`, hasQ ? [like] : []);
    case 'locations':
      return db.query(`SELECT id, name, address, city FROM locations ${hasQ ? 'WHERE (name ILIKE $1 OR city ILIKE $1)' : ''} ORDER BY name LIMIT 100`, hasQ ? [like] : []);
    case 'sub_locations':
      return db.query(
        `SELECT sl.id, sl.name, sl.code, sl.floor, sl.room, l.name AS location_name FROM sub_locations sl
         LEFT JOIN locations l ON sl.location_id = l.id
         ${hasQ ? 'WHERE (sl.name ILIKE $1 OR sl.code ILIKE $1 OR l.name ILIKE $1)' : ''} ORDER BY sl.name LIMIT 100`,
        hasQ ? [like] : []);
    case 'status_labels':
      return db.query(`SELECT id, name, type, color FROM status_labels ${hasQ ? 'WHERE name ILIKE $1' : ''} ORDER BY name LIMIT 100`, hasQ ? [like] : []);
    default:
      throw new HttpError(`Unknown type: ${type}`, 400);
  }
}

module.exports = {
  TABLES, page, overviewCards, all, create, update, remove, bulkDelete, search, getCreatedRecord
};
