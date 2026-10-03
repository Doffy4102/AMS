// Port of StockMovementService: movement ledger UI operations.
const db = require('../core/db');
const audit = require('./auditService');
const ledger = require('./movementLedgerService');
const { nullableId, HttpError, trimStr, intOr } = require('../core/helpers');

const MODULES = {
  assets: { label: 'Hardware Asset', table: 'assets', stock: null },
  accessories: { label: 'Accessory', table: 'accessories', stock: 'available_qty' },
  consumables: { label: 'Consumable', table: 'consumables', stock: 'remaining_qty' },
  components: { label: 'Component', table: 'components', stock: 'available_qty' }
};

const EXPORT_LABELS = { ...Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, v.label])), licenses: 'License' };
const EXPORT_TABLES = { ...Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, v.table])), licenses: 'licenses' };

async function itemName(moduleKey, itemId) {
  const table = EXPORT_TABLES[moduleKey];
  if (!table || !itemId) return `#${itemId}`;
  const row = await db.get(`SELECT name FROM ${table} WHERE id = $1`, [itemId]);
  return row ? row.name : `#${itemId}`;
}

async function movements(filters = {}) {
  const where = [];
  const params = [];
  let i = 1;
  const moduleKey = filters.module_key || filters.module || '';
  if (moduleKey && MODULES[moduleKey]) { where.push(`sm.module_key = $${i++}`); params.push(moduleKey); }
  if (filters.item_id) { where.push(`sm.item_id = $${i++}`); params.push(parseInt(filters.item_id, 10)); }
  if (filters.search) {
    where.push(`(sm.reason ILIKE $${i} OR sm.reference ILIKE $${i} OR sm.notes ILIKE $${i} OR sm.module_key ILIKE $${i} OR sm.movement_type ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i += 1;
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.query(
    `SELECT sm.*, u.name AS created_by_name FROM stock_movements sm
     LEFT JOIN users u ON u.id = sm.created_by ${whereSql}
     ORDER BY sm.created_at DESC, sm.id DESC LIMIT 250`,
    params);
  for (const r of rows) {
    r.module_label = EXPORT_LABELS[r.module_key] || r.module_key;
    r.item_name = await itemName(r.module_key, r.item_id);
    if (r.module_key === 'assets') {
      const a = await db.get('SELECT serial_number, asset_tag FROM assets WHERE id = $1', [r.item_id]);
      r.serial_number = a ? a.serial_number : '';
      r.asset_tag = a ? a.asset_tag : '';
    } else {
      r.serial_number = '';
      r.asset_tag = '';
    }
  }
  return rows;
}

async function pageData(filters = {}) {
  const items = [];
  for (const [key, mod] of Object.entries(MODULES)) {
    const rows = await db.query(`SELECT id, name FROM ${mod.table} ORDER BY name ASC LIMIT 1000`);
    for (const r of rows) items.push({ ...r, module_key: key });
  }
  const [locations, users, suppliers, currentAssets] = await Promise.all([
    db.query('SELECT id, name FROM locations ORDER BY name ASC'),
    db.query('SELECT id, name, email FROM users WHERE deleted_at IS NULL ORDER BY name ASC'),
    db.query('SELECT id, name FROM suppliers ORDER BY name ASC'),
    db.query(
      `SELECT a.id, a.name, a.asset_tag, a.serial_number, a.status, a.assigned_to,
              sl.name AS status_label_name, sl.color AS status_label_color,
              u.name AS assigned_to_name, l.name AS location_name
       FROM assets a
       LEFT JOIN status_labels sl ON a.status_label_id = sl.id
       LEFT JOIN users u ON a.assigned_to = u.id
       LEFT JOIN locations l ON a.location_id = l.id
       WHERE a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 250`)
  ]);
  return {
    modules: MODULES,
    items,
    locations, users, suppliers,
    current_assets: currentAssets,
    movements: await movements(filters),
    filters: {
      module_key: filters.module_key || filters.module || '',
      item_id: filters.item_id || '',
      search: filters.search || ''
    }
  };
}

function resolveItem(data) {
  if (data.item_ref && String(data.item_ref).includes(':')) {
    const [mk, id] = String(data.item_ref).split(':');
    return [mk, parseInt(id, 10) || 0];
  }
  return [data.module_key || 'assets', intOr(data.item_id, 0)];
}

async function applyQuantityChange(t, moduleKey, itemId, direction, qty) {
  const mod = MODULES[moduleKey];
  if (!mod || !mod.stock) return;
  if (direction === 'in') {
    await t.run(`UPDATE ${mod.table} SET ${mod.stock} = ${mod.stock} + $1, total_qty = total_qty + $1 WHERE id = $2`, [qty, itemId]);
  } else {
    const row = await t.get(`SELECT ${mod.stock} AS avail FROM ${mod.table} WHERE id = $1 FOR UPDATE`, [itemId]);
    if (!row || intOr(row.avail) < qty) throw new HttpError('Not enough stock available for this movement.', 422);
    await t.run(`UPDATE ${mod.table} SET ${mod.stock} = ${mod.stock} - $1 WHERE id = $2`, [qty, itemId]);
  }
}

async function create(data, userId) {
  const [moduleKey, itemId] = resolveItem(data);
  const direction = data.direction === 'out' ? 'out' : 'in';
  const quantity = Math.max(1, intOr(data.quantity, 1));
  const mod = MODULES[moduleKey];
  if (!mod) throw new HttpError('Invalid stock module selected.', 422);
  if (!itemId || !(await db.get(`SELECT id FROM ${mod.table} WHERE id = $1`, [itemId]))) {
    throw new HttpError('Selected stock item was not found.', 404);
  }
  await db.tx(async t => {
    await ledger.record({
      module_key: moduleKey, item_id: itemId,
      movement_type: data.movement_type || (direction === 'in' ? 'stock_in' : 'stock_out'),
      direction, quantity,
      from_location_id: nullableId(data.from_location_id),
      to_location_id: nullableId(data.to_location_id),
      holder_user_id: nullableId(data.holder_user_id),
      vendor_id: nullableId(data.vendor_id),
      effective_status: data.effective_status || null,
      reason: trimStr(data.reason), reference: trimStr(data.reference), notes: trimStr(data.notes),
      created_by: userId
    }, t);
    await applyQuantityChange(t, moduleKey, itemId, direction, quantity);
  });
  const name = await itemName(moduleKey, itemId);
  await audit.log(userId, 'STOCK_MOVEMENT',
    `${direction} movement recorded for ${moduleKey}: ${name}. Quantity: ${quantity}. Reason: ${trimStr(data.reason) || 'None'}`);
  return true;
}

async function update(id, data, userId) {
  const existing = await db.get('SELECT * FROM stock_movements WHERE id = $1', [id]);
  if (!existing) throw new HttpError('Stock movement not found.', 404);
  await db.run('UPDATE stock_movements SET reason=$1, reference=$2, notes=$3 WHERE id=$4',
    [trimStr(data.reason, existing.reason), trimStr(data.reference, existing.reference), trimStr(data.notes, existing.notes), id]);
  const name = await itemName(existing.module_key, existing.item_id);
  await audit.log(userId, 'STOCK_MOVEMENT_UPDATE',
    `Updated metadata for stock movement #${id} (${existing.module_key}: ${name})`);
  return true;
}

async function reverseQuantityChange(t, movement) {
  const mod = MODULES[movement.module_key];
  if (!mod || !mod.stock) return;
  const qty = intOr(movement.quantity, 1);
  if (movement.direction === 'in') {
    await t.run(
      `UPDATE ${mod.table} SET ${mod.stock} = GREATEST(0, ${mod.stock} - $1), total_qty = GREATEST(0, total_qty - $1) WHERE id = $2`,
      [qty, movement.item_id]);
  } else {
    await t.run(`UPDATE ${mod.table} SET ${mod.stock} = ${mod.stock} + $1 WHERE id = $2`, [qty, movement.item_id]);
  }
}

async function rollback(id, userId) {
  const movement = await db.get('SELECT * FROM stock_movements WHERE id = $1', [id]);
  if (!movement) throw new HttpError('Stock movement not found.', 404);
  await db.tx(async t => {
    await reverseQuantityChange(t, movement);
    await t.run('DELETE FROM stock_movements WHERE id = $1', [id]);
  });
  const name = await itemName(movement.module_key, movement.item_id);
  await audit.log(userId, 'STOCK_ROLLBACK',
    `Rolled back stock movement #${id} for ${movement.module_key}: ${name}. Quantity: ${movement.quantity}. Direction: ${movement.direction}`);
  return true;
}

async function bulkRollback(ids, userId) {
  ids = [...new Set(ids.map(Number).filter(Boolean))];
  if (!ids.length) return false;
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.query(`SELECT * FROM stock_movements WHERE id IN (${ph})`, ids);
  if (!rows.length) return false;
  await db.tx(async t => {
    // Consolidate reverse operations per table.column.item.op
    const grouped = {};
    for (const m of rows) {
      const mod = MODULES[m.module_key];
      if (!mod || !mod.stock) continue;
      const op = m.direction === 'in' ? '-' : '+';
      const key = `${mod.table}.${mod.stock}.${m.item_id}.${op}`;
      grouped[key] = (grouped[key] || 0) + intOr(m.quantity, 1);
    }
    for (const [key, qty] of Object.entries(grouped)) {
      const [table, col, itemId, op] = key.split('.');
      await t.run(`UPDATE ${table} SET ${col} = ${col} ${op} $1 WHERE id = $2`, [qty, parseInt(itemId, 10)]);
    }
    for (const m of rows) {
      const name = await itemName(m.module_key, m.item_id);
      await audit.log(userId, 'STOCK_ROLLBACK',
        `Rolled back stock movement #${m.id} (Bulk) for ${m.module_key}: ${name}. Quantity: ${m.quantity}. Direction: ${m.direction}`);
    }
    const ph2 = rows.map((_, i) => `$${i + 1}`).join(', ');
    await t.run(`DELETE FROM stock_movements WHERE id IN (${ph2})`, rows.map(r => r.id));
  });
  return true;
}

async function exportRows(ids) {
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.query(
    `SELECT sm.*, u.name AS created_by_name FROM stock_movements sm
     LEFT JOIN users u ON u.id = sm.created_by
     WHERE sm.id IN (${ph}) ORDER BY sm.created_at DESC, sm.id DESC`, ids);
  for (const r of rows) {
    r.item_name = await itemName(r.module_key, r.item_id);
    r.module_label = EXPORT_LABELS[r.module_key] || r.module_key;
  }
  return rows;
}

module.exports = { MODULES, pageData, movements, create, update, rollback, bulkRollback, exportRows };
