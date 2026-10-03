// Port of InventoryService (~960 lines): 4 inventory types.
const db = require('../core/db');
const audit = require('./auditService');
const authz = require('./authorizationService');
const ledger = require('./movementLedgerService');
const notifications = require('./notificationService');
const customFields = require('./customFieldService');
const Paginator = require('../core/paginator');
const { validate } = require('../core/validator');
const { nullableId, HttpError, extractCustomFields, trimStr, intOr } = require('../core/helpers');

const TABLE_MAP = {
  accessories: 'accessories',
  consumables: 'consumables',
  components: 'components',
  licenses: 'licenses'
};

const META = {
  accessories: { title: 'Accessories', group: 'Asset Management', icon: 'mouse', description: 'Track assignable peripherals, chargers, bags, and other reusable accessories.' },
  components: { title: 'Components', group: 'Asset Management', icon: 'cpu', description: 'Manage installable asset parts such as RAM, SSDs, docks, and spares.' },
  licenses: { title: 'Licenses', group: 'License Management', icon: 'key-round', description: 'Manage software licenses, seats, keys, expiry dates, and assignments.' },
  consumables: { title: 'Consumables', group: 'Inventory Module', icon: 'package-minus', description: 'Issue and monitor consumable stock such as toner, cables, batteries, and supplies.' }
};

function tableFor(type) {
  const table = TABLE_MAP[type];
  if (!table) throw new HttpError(`Unknown inventory type: ${type}`, 400);
  return table;
}

function jsonCf(data) {
  return JSON.stringify(extractCustomFields(data));
}

async function assertLocationAllowed(locationId, user) {
  if (!(await authz.canAccessLocation(locationId, user))) {
    throw new HttpError('You do not have access to manage inventory in this location.', 403);
  }
}

async function checkStockLevels(type, id) {
  const table = tableFor(type);
  const qtyCol = type === 'consumables' ? 'remaining_qty' : (type === 'licenses' ? 'available_seats' : 'available_qty');
  const minCol = type === 'licenses' ? '0' : 'min_qty';
  const row = await db.get(`SELECT name, ${qtyCol} AS qty, ${minCol} AS min_qty FROM ${table} WHERE id = $1`, [id]);
  if (!row) return;
  const qty = intOr(row.qty), min = intOr(row.min_qty);
  if (qty <= min && min > 0) {
    await notifications.send(null, 'LOW_STOCK', `Low Stock Alert: ${row.name}`,
      `The inventory item '${row.name}' has reached its minimum threshold. Current: ${qty}, Min: ${min}.`);
  }
}

async function recordInventoryStockAdjustment(moduleKey, itemId, delta, locationId, reason, userId) {
  if (!delta) return;
  await ledger.record({
    module_key: moduleKey, item_id: itemId,
    movement_type: delta > 0 ? 'stock_in' : 'stock_out',
    direction: delta > 0 ? 'in' : 'out',
    quantity: Math.abs(delta),
    to_location_id: delta > 0 ? locationId : null,
    from_location_id: delta < 0 ? locationId : null,
    effective_status: delta > 0 ? 'available' : null,
    reason,
    notes: 'Recorded automatically from inventory quantity update.',
    created_by: userId
  });
}

// ---- create / update ----
async function create(type, data, user) {
  const base = validate(data, { name: 'required|max:255' });
  if (base.fails) throw new HttpError(base.firstError, 422);
  const table = tableFor(type);
  const userId = user ? user.id : null;
  let id;

  if (type === 'accessories' || type === 'components') {
    const v = validate(data, { total_qty: 'integer|min:0', min_qty: 'integer|min:0' });
    if (v.fails) throw new HttpError(v.firstError, 422);
    await assertLocationAllowed(data.location_id, user);
    const qty = Math.max(0, intOr(data.total_qty, 0));
    const minQty = Math.max(0, intOr(data.min_qty, 0));
    const cols = ['name', 'category_id', 'manufacturer_id', 'supplier_id', 'location_id', 'sub_location_id'];
    const vals = [trimStr(data.name), nullableId(data.category_id), nullableId(data.manufacturer_id),
      nullableId(data.supplier_id), nullableId(data.location_id), nullableId(data.sub_location_id)];
    if (type === 'accessories') {
      cols.push('model_number', 'serial_number');
      vals.push(trimStr(data.model_number), trimStr(data.serial_number));
    } else {
      cols.push('serial_number');
      vals.push(trimStr(data.serial_number));
    }
    cols.push('total_qty', 'available_qty', 'min_qty', 'notes', 'custom_fields_data');
    vals.push(qty, qty, minQty, trimStr(data.notes), jsonCf(data));
    id = await db.insert(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    if (id && qty > 0) {
      await recordInventoryStockAdjustment(table, id, qty, nullableId(data.location_id), 'Inventory item created', userId);
    }
  } else if (type === 'consumables') {
    const v = validate(data, { total_qty: 'integer|min:0', min_qty: 'integer|min:0' });
    if (v.fails) throw new HttpError(v.firstError, 422);
    await assertLocationAllowed(data.location_id, user);
    const qty = Math.max(0, intOr(data.total_qty, 0));
    id = await db.insert(
      `INSERT INTO consumables (name, category_id, manufacturer_id, supplier_id, location_id, sub_location_id,
         total_qty, remaining_qty, min_qty, notes, custom_fields_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [trimStr(data.name), nullableId(data.category_id), nullableId(data.manufacturer_id),
        nullableId(data.supplier_id), nullableId(data.location_id), nullableId(data.sub_location_id),
        qty, qty, Math.max(0, intOr(data.min_qty, 0)), trimStr(data.notes), jsonCf(data)]);
    if (id && qty > 0) {
      await recordInventoryStockAdjustment('consumables', id, qty, nullableId(data.location_id), 'Inventory item created', userId);
    }
  } else if (type === 'licenses') {
    const v = validate(data, { seats: 'integer|min:1', expiration_date: 'date' });
    if (v.fails) throw new HttpError(v.firstError, 422);
    const seats = Math.max(1, intOr(data.seats, 1));
    id = await db.insert(
      `INSERT INTO licenses (name, category_id, license_manufacturer_id, license_supplier_id, location_id, sub_location_id,
         seats, available_seats, license_key, product_key, order_number, purchase_order_number, purchase_date,
         purchase_cost, expiration_date, termination_date, purchase_type, license_type, maintained, reassignable,
         checkout_email, licensed_to_name, licensed_to_email, notes, custom_fields_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [trimStr(data.name), nullableId(data.category_id), nullableId(data.manufacturer_id), nullableId(data.supplier_id),
        nullableId(data.location_id), nullableId(data.sub_location_id), seats, seats,
        trimStr(data.license_key), trimStr(data.product_key), trimStr(data.order_number), trimStr(data.purchase_order_number),
        data.purchase_date || null,
        data.purchase_cost !== '' && data.purchase_cost != null ? data.purchase_cost : null,
        data.expiration_date || null, data.termination_date || null,
        trimStr(data.purchase_type), trimStr(data.license_type),
        !!data.maintained, Object.prototype.hasOwnProperty.call(data, 'reassignable'), !!data.checkout_email,
        trimStr(data.licensed_to_name), trimStr(data.licensed_to_email), trimStr(data.notes), jsonCf(data)]);
  }

  if (id) {
    await audit.log(userId, 'INVENTORY_CREATED', `Created ${type}: ${trimStr(data.name)}`);
    await checkStockLevels(type, id);
  }
  return id;
}

async function findInventoryRecord(type, id) {
  const table = tableFor(type);
  return db.get(`SELECT * FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
}

async function update(type, id, data, user) {
  const base = validate(data, { name: 'required|max:255' });
  if (base.fails) throw new HttpError(base.firstError, 422);
  const table = tableFor(type);
  const userId = user ? user.id : null;
  const existing = await findInventoryRecord(type, id);

  if (type === 'accessories' || type === 'components') {
    if (!existing) throw new HttpError('Inventory item not found.', 404);
    const v = validate(data, { total_qty: 'integer|min:0', min_qty: 'integer|min:0' });
    if (v.fails) throw new HttpError(v.firstError, 422);
    await assertLocationAllowed(data.location_id, user);
    const assigned = Math.max(0, intOr(existing.total_qty) - intOr(existing.available_qty));
    const qty = Math.max(0, intOr(data.total_qty, 0));
    const available = Math.max(0, qty - assigned);
    const sets = ['name = $1', 'category_id = $2', 'manufacturer_id = $3', 'supplier_id = $4',
      'location_id = $5', 'sub_location_id = $6'];
    const vals = [trimStr(data.name), nullableId(data.category_id), nullableId(data.manufacturer_id),
      nullableId(data.supplier_id), nullableId(data.location_id), nullableId(data.sub_location_id)];
    let i = 7;
    if (type === 'accessories') {
      sets.push(`model_number = $${i++}`, `serial_number = $${i++}`);
      vals.push(trimStr(data.model_number), trimStr(data.serial_number));
    } else {
      sets.push(`serial_number = $${i++}`);
      vals.push(trimStr(data.serial_number));
    }
    sets.push(`total_qty = $${i++}`, `available_qty = $${i++}`, `min_qty = $${i++}`, `notes = $${i++}`, `custom_fields_data = $${i++}`);
    vals.push(qty, available, Math.max(0, intOr(data.min_qty, 0)), trimStr(data.notes), jsonCf(data));
    vals.push(id);
    await db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    const delta = qty - intOr(existing.total_qty);
    if (delta !== 0) {
      await recordInventoryStockAdjustment(table, id, delta, nullableId(data.location_id), 'Inventory quantity adjusted', userId);
    }
  } else if (type === 'consumables') {
    if (!existing) throw new HttpError('Consumable not found.', 404);
    const v = validate(data, { total_qty: 'integer|min:0', min_qty: 'integer|min:0' });
    if (v.fails) throw new HttpError(v.firstError, 422);
    await assertLocationAllowed(data.location_id, user);
    const issued = Math.max(0, intOr(existing.total_qty) - intOr(existing.remaining_qty));
    const qty = Math.max(0, intOr(data.total_qty, 0));
    const remaining = Math.max(0, qty - issued);
    await db.run(
      `UPDATE consumables SET name = $1, category_id = $2, manufacturer_id = $3, supplier_id = $4,
         location_id = $5, sub_location_id = $6, total_qty = $7, remaining_qty = $8, min_qty = $9,
         notes = $10, custom_fields_data = $11 WHERE id = $12`,
      [trimStr(data.name), nullableId(data.category_id), nullableId(data.manufacturer_id),
        nullableId(data.supplier_id), nullableId(data.location_id), nullableId(data.sub_location_id),
        qty, remaining, Math.max(0, intOr(data.min_qty, 0)), trimStr(data.notes), jsonCf(data), id]);
    const delta = qty - intOr(existing.total_qty);
    if (delta !== 0) {
      await recordInventoryStockAdjustment('consumables', id, delta, nullableId(data.location_id), 'Inventory quantity adjusted', userId);
    }
  } else if (type === 'licenses') {
    if (!existing) throw new HttpError('License not found.', 404);
    const v = validate(data, { seats: 'integer|min:1', expiration_date: 'date' });
    if (v.fails) throw new HttpError(v.firstError, 422);
    const assigned = Math.max(0, intOr(existing.seats) - intOr(existing.available_seats));
    const seats = Math.max(1, intOr(data.seats, 1));
    const available = Math.max(0, seats - assigned);
    await db.run(
      `UPDATE licenses SET name = $1, category_id = $2, license_manufacturer_id = $3, license_supplier_id = $4,
         location_id = $5, sub_location_id = $6, seats = $7, available_seats = $8, license_key = $9,
         product_key = $10, order_number = $11, purchase_order_number = $12, purchase_date = $13,
         purchase_cost = $14, expiration_date = $15, termination_date = $16, purchase_type = $17,
         license_type = $18, maintained = $19, reassignable = $20, checkout_email = $21,
         licensed_to_name = $22, licensed_to_email = $23, notes = $24, custom_fields_data = $25
       WHERE id = $26`,
      [trimStr(data.name), nullableId(data.category_id), nullableId(data.manufacturer_id), nullableId(data.supplier_id),
        nullableId(data.location_id), nullableId(data.sub_location_id), seats, available,
        trimStr(data.license_key), trimStr(data.product_key), trimStr(data.order_number), trimStr(data.purchase_order_number),
        data.purchase_date || null,
        data.purchase_cost !== '' && data.purchase_cost != null ? data.purchase_cost : null,
        data.expiration_date || null, data.termination_date || null,
        trimStr(data.purchase_type), trimStr(data.license_type),
        !!data.maintained, Object.prototype.hasOwnProperty.call(data, 'reassignable'), !!data.checkout_email,
        trimStr(data.licensed_to_name), trimStr(data.licensed_to_email), trimStr(data.notes), jsonCf(data), id]);
  }

  await audit.log(userId, 'INVENTORY_UPDATED', `Updated ${type} #${id}: ${trimStr(data.name)}`);
  await checkStockLevels(type, id);
  return true;
}

async function remove(type, id, user) {
  const table = tableFor(type);
  const res = await db.run(`UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  await audit.log(user ? user.id : null, 'INVENTORY_DELETED', `Deleted ${type} record #${id}.`);
  return res.rowCount > 0;
}

async function bulkDelete(type, ids, user) {
  const table = tableFor(type);
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length) return 0;
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const res = await db.run(`UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${ph})`, ids);
  if (res.rowCount > 0) {
    await audit.log(user ? user.id : null, 'INVENTORY_BULK_DELETED',
      `Bulk deleted ${res.rowCount} ${type} record(s). IDs: ${ids.join(',')}`);
  }
  return res.rowCount;
}

// ---- page data ----
async function stats(type) {
  const mk = (label, value, icon) => ({ label, value: intOr(value), icon });
  if (type === 'accessories' || type === 'components') {
    const table = tableFor(type);
    const r = await db.get(
      `SELECT COUNT(*)::int AS records, COALESCE(SUM(total_qty),0)::int AS total,
              COALESCE(SUM(available_qty),0)::int AS available,
              COALESCE(SUM(GREATEST(total_qty - available_qty, 0)),0)::int AS assigned,
              COALESCE(SUM(CASE WHEN min_qty > 0 AND available_qty <= min_qty THEN 1 ELSE 0 END),0)::int AS low
       FROM ${table} WHERE deleted_at IS NULL`);
    return [mk('Records', r.records, 'database'), mk('Total Stock', r.total, 'layers-3'),
      mk('Available', r.available, 'check-circle-2'),
      mk(type === 'components' ? 'Installed' : 'Assigned', r.assigned, 'send'),
      mk('Low Stock', r.low, 'triangle-alert')];
  }
  if (type === 'consumables') {
    const r = await db.get(
      `SELECT COUNT(*)::int AS records, COALESCE(SUM(total_qty),0)::int AS total,
              COALESCE(SUM(remaining_qty),0)::int AS remaining,
              COALESCE(SUM(GREATEST(total_qty - remaining_qty, 0)),0)::int AS issued,
              COALESCE(SUM(CASE WHEN min_qty > 0 AND remaining_qty <= min_qty THEN 1 ELSE 0 END),0)::int AS low
       FROM consumables WHERE deleted_at IS NULL`);
    return [mk('Records', r.records, 'database'), mk('Total Stock', r.total, 'layers-3'),
      mk('Remaining', r.remaining, 'check-circle-2'), mk('Issued', r.issued, 'send'),
      mk('Low Stock', r.low, 'triangle-alert')];
  }
  if (type === 'licenses') {
    const r = await db.get(
      `SELECT COUNT(*)::int AS records, COALESCE(SUM(seats),0)::int AS seats,
              COALESCE(SUM(available_seats),0)::int AS available,
              COALESCE(SUM(GREATEST(seats - available_seats, 0)),0)::int AS assigned,
              COALESCE(SUM(CASE WHEN expiration_date IS NOT NULL AND expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days' THEN 1 ELSE 0 END),0)::int AS expiring
       FROM licenses WHERE deleted_at IS NULL`);
    return [mk('Licenses', r.records, 'database'), mk('Total Seats', r.seats, 'users'),
      mk('Available Seats', r.available, 'check-circle-2'), mk('Assigned Seats', r.assigned, 'send'),
      mk('Expiring Soon', r.expiring, 'calendar-clock')];
  }
  return [];
}

async function references(type, user) {
  const scope = await authz.locationScopeFor(user);
  const mfTable = type === 'licenses' ? 'license_manufacturers' : 'manufacturers';
  const supTable = type === 'licenses' ? 'license_suppliers' : 'suppliers';
  const [categories, manufacturers, suppliers, locationsAll] = await Promise.all([
    db.query('SELECT * FROM asset_categories ORDER BY name ASC LIMIT 1000'),
    db.query(`SELECT * FROM ${mfTable} WHERE deleted_at IS NULL ORDER BY name ASC LIMIT 1000`),
    db.query(`SELECT * FROM ${supTable} WHERE deleted_at IS NULL ORDER BY name ASC LIMIT 1000`),
    db.query('SELECT * FROM locations ORDER BY name ASC LIMIT 1000')
  ]);
  const locations = scope.global ? locationsAll
    : locationsAll.filter(l => scope.location_ids.includes(parseInt(l.id, 10)));
  const locIds = locations.map(l => l.id);
  let subLocations = [];
  if (locIds.length) {
    const ph = locIds.map((_, i) => `$${i + 1}`).join(', ');
    subLocations = await db.query(
      `SELECT id, location_id, name, code FROM sub_locations WHERE location_id IN (${ph}) AND deleted_at IS NULL ORDER BY name ASC`,
      locIds);
  }
  const cf = await customFields.getFieldsByModule(type);
  const [users, assets] = await Promise.all([
    db.query('SELECT id, name, email FROM users WHERE deleted_at IS NULL ORDER BY name ASC LIMIT 1000'),
    db.query('SELECT id, name, asset_tag FROM assets WHERE deleted_at IS NULL ORDER BY name ASC LIMIT 1000')
  ]);
  const refs = {
    categories, manufacturers, suppliers, locations, sub_locations: subLocations,
    custom_fields: cf, workflow: { users, assets }
  };
  return refs;
}

async function page(type, pageNum = 1, perPage = 15, filters = {}, user = null) {
  if (!TABLE_MAP[type]) throw new HttpError('Unknown inventory module', 404);
  const table = TABLE_MAP[type];
  const meta = META[type] || { title: type, group: 'Inventory Module', icon: 'package', description: 'Manage inventory records.' };
  const scoped = await authz.applyLocationScope(filters, user);

  const params = [];
  const where = [];
  let i = 1;
  if (scoped.search) { where.push(`name ILIKE $${i++}`); params.push(`%${scoped.search}%`); }
  if (type !== 'licenses' && Array.isArray(scoped.location_ids) && scoped.location_ids.length) {
    const ph = scoped.location_ids.map(() => `$${i++}`);
    where.push(`location_id IN (${ph.join(', ')})`);
    params.push(...scoped.location_ids);
  }
  where.push('deleted_at IS NULL');
  const whereSql = where.join(' AND ');

  const totalRow = await db.get(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${whereSql}`, params);
  const paginator = new Paginator(totalRow.c, perPage, pageNum);

  let items;
  if (type === 'licenses') {
    items = await db.query(
      `SELECT l.*, COALESCE(lm.name, m.name) AS manufacturer_name, COALESCE(ls.name, s.name) AS supplier_name,
              ac.name AS category_name
       FROM licenses l
       LEFT JOIN manufacturers m ON l.manufacturer_id = m.id
       LEFT JOIN suppliers s ON l.supplier_id = s.id
       LEFT JOIN license_manufacturers lm ON l.license_manufacturer_id = lm.id
       LEFT JOIN license_suppliers ls ON l.license_supplier_id = ls.id
       LEFT JOIN asset_categories ac ON l.category_id = ac.id
       WHERE ${whereSql.replace(/\bname ILIKE/, 'l.name ILIKE').replace(/\blocation_id IN/, 'l.location_id IN').replace(/\bdeleted_at IS NULL/, 'l.deleted_at IS NULL')}
       ORDER BY l.name ASC LIMIT ${perPage} OFFSET ${paginator.offset}`,
      params);
    const ids = items.map(x => x.id);
    if (ids.length) {
      const ph = ids.map((_, k) => `$${k + 1}`).join(', ');
      const assigns = await db.query(
        `SELECT la.id, la.assigned_at, la.license_id, u.name AS user_name, u.email AS user_email,
                a.name AS asset_name, a.asset_tag
         FROM license_assignments la
         LEFT JOIN users u ON la.user_id = u.id
         LEFT JOIN assets a ON la.asset_id = a.id
         WHERE la.license_id IN (${ph}) AND la.revoked_at IS NULL`, ids);
      for (const item of items) item.assignments = assigns.filter(x => x.license_id === item.id);
    }
  } else {
    items = await db.query(
      `SELECT i.*, ac.name AS category_name, m.name AS manufacturer_name, s.name AS supplier_name, l.name AS location_name
       FROM ${table} i
       LEFT JOIN asset_categories ac ON i.category_id = ac.id
       LEFT JOIN manufacturers m ON i.manufacturer_id = m.id
       LEFT JOIN suppliers s ON i.supplier_id = s.id
       LEFT JOIN locations l ON i.location_id = l.id
       WHERE ${whereSql.replace(/\bname ILIKE/, 'i.name ILIKE').replace(/\blocation_id IN/, 'i.location_id IN').replace(/\bdeleted_at IS NULL/, 'i.deleted_at IS NULL')}
       ORDER BY i.name ASC LIMIT ${perPage} OFFSET ${paginator.offset}`,
      params);
    const ids = items.map(x => x.id);
    if (ids.length && type === 'accessories') {
      const ph = ids.map((_, k) => `$${k + 1}`).join(', ');
      const assigns = await db.query(
        `SELECT aa.id, aa.qty, aa.assigned_at, aa.accessory_id, u.name AS user_name, u.email AS user_email
         FROM accessory_assignments aa JOIN users u ON aa.user_id = u.id
         WHERE aa.accessory_id IN (${ph}) AND aa.returned_at IS NULL`, ids);
      for (const item of items) item.assignments = assigns.filter(x => x.accessory_id === item.id);
    } else if (ids.length && type === 'components') {
      const ph = ids.map((_, k) => `$${k + 1}`).join(', ');
      const assigns = await db.query(
        `SELECT ca.id, ca.qty, ca.assigned_at, ca.component_id, a.name AS asset_name, a.asset_tag,
                u.name AS user_name, u.email AS user_email
         FROM component_assignments ca
         JOIN assets a ON ca.asset_id = a.id
         LEFT JOIN users u ON a.assigned_to = u.id
         WHERE ca.component_id IN (${ph}) AND ca.removed_at IS NULL`, ids);
      for (const item of items) item.assignments = assigns.filter(x => x.component_id === item.id);
    } else {
      for (const item of items) item.assignments = item.assignments || [];
    }
  }

  return {
    type, ...META[type] || meta,
    stats: await stats(type),
    items,
    references: await references(type, user),
    paginator
  };
}

module.exports = {
  TABLE_MAP, META, create, update, remove, bulkDelete, page, stats, references,
  findInventoryRecord, checkStockLevels
};
