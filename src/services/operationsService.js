// Port of OperationsService: alerts, audit, maintenance (with repair lifecycle).
const db = require('../core/db');
const ledger = require('./movementLedgerService');
const { nullableId, HttpError, trimStr } = require('../core/helpers');

async function lowStock(table, column) {
  return db.query(
    `SELECT id, name, ${column} AS available_qty, total_qty, min_qty FROM ${table}
     WHERE deleted_at IS NULL AND min_qty > 0 AND ${column} <= min_qty
     ORDER BY ${column} ASC LIMIT 250`);
}

async function alerts() {
  const [warranties, licenses, accessories, consumables, components] = await Promise.all([
    db.query(
      `SELECT id, name, asset_tag, warranty_expiry FROM assets
       WHERE warranty_expiry IS NOT NULL AND deleted_at IS NULL
         AND warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'
       ORDER BY warranty_expiry ASC LIMIT 250`),
    db.query(
      `SELECT id, name, expiration_date FROM licenses
       WHERE expiration_date IS NOT NULL AND deleted_at IS NULL
         AND expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'
       ORDER BY expiration_date ASC LIMIT 250`),
    lowStock('accessories', 'available_qty'),
    lowStock('consumables', 'remaining_qty'),
    lowStock('components', 'available_qty')
  ]);
  return { warranties, licenses, accessories, consumables, components };
}

async function auditLogs(limit = 100) {
  return db.query(
    `SELECT l.*, u.name AS user_name FROM activity_logs l
     LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC LIMIT $1`,
    [limit]);
}

async function maintenanceRecords(filters = {}) {
  const where = ['a.deleted_at IS NULL'];
  const params = [];
  let i = 1;
  if (filters.status) { where.push(`m.status = $${i++}`); params.push(filters.status); }
  if (filters.type) { where.push(`m.maintenance_type = $${i++}`); params.push(filters.type); }
  if (filters.search) {
    where.push(`(m.title ILIKE $${i} OR m.notes ILIKE $${i} OR a.name ILIKE $${i} OR a.asset_tag ILIKE $${i} OR s.name ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i += 1;
  }
  return db.query(
    `SELECT m.*, a.name AS asset_name, a.asset_tag, s.name AS vendor_name, u.name AS created_by_name
     FROM asset_maintenance m
     JOIN assets a ON m.asset_id = a.id
     LEFT JOIN suppliers s ON m.vendor_id = s.id
     LEFT JOIN users u ON m.created_by = u.id
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC LIMIT 500`,
    params);
}

async function maintenanceReferences() {
  const [assets, suppliers] = await Promise.all([
    db.query(
      `SELECT a.id, a.name, a.asset_tag FROM assets a
       LEFT JOIN status_labels sl ON a.status_label_id = sl.id
       WHERE a.deleted_at IS NULL
         AND LOWER(COALESCE(sl.name, a.status, '')) NOT IN ('lost', 'retired', 'disposed')
       ORDER BY a.name ASC LIMIT 1000`),
    db.query('SELECT id, name FROM suppliers ORDER BY name ASC')
  ]);
  return { assets, suppliers };
}

async function applyRepairLifecycle(t, asset, maintenanceId, oldStatus, status, data, userId) {
  const completed = status === 'completed';
  const wasCompleted = oldStatus === 'completed';
  const assetInRepair = String(asset.status || '').toLowerCase() === 'repair';
  const shouldRecordMovement = oldStatus === null || completed !== wasCompleted || (!completed && !assetInRepair);
  if (!shouldRecordMovement) return;

  let targetStatus, label;
  if (completed) {
    targetStatus = 'available';
    label = await t.get(`SELECT id FROM status_labels WHERE name IN ('In Stock', 'Ready to Deploy') ORDER BY CASE name WHEN 'In Stock' THEN 0 ELSE 1 END LIMIT 1`);
  } else {
    targetStatus = 'repair';
    label = await t.get(`SELECT id FROM status_labels WHERE name = 'In Repair' LIMIT 1`);
  }

  let assignmentId = null;
  const holderUserId = asset.assigned_to;
  if (asset.assigned_to) {
    const open = await t.get(
      'SELECT id FROM assignments WHERE asset_id = $1 AND returned_at IS NULL ORDER BY assigned_at DESC, id DESC LIMIT 1',
      [asset.id]);
    if (open) {
      assignmentId = open.id;
      await t.run(
        `UPDATE assignments SET returned_at = CURRENT_TIMESTAMP, checked_in_by = $1, checkin_condition = $2, checkin_notes = $3 WHERE id = $4`,
        [userId, completed ? 'repair_completed' : 'repair',
          completed ? `Repair completed via maintenance #${maintenanceId}` : `Sent for repair via maintenance #${maintenanceId}`,
          open.id]);
    }
  }
  await t.run('UPDATE assets SET assigned_to = NULL, status = $1, status_label_id = COALESCE($2, status_label_id) WHERE id = $3',
    [targetStatus, label ? label.id : null, asset.id]);
  await ledger.record({
    module_key: 'assets', item_id: asset.id,
    movement_type: completed ? 'repair_received' : 'repair_sent',
    direction: completed ? 'in' : 'out', quantity: 1,
    from_location_id: completed ? null : asset.location_id,
    to_location_id: completed ? asset.location_id : null,
    holder_user_id: holderUserId, vendor_id: nullableId(data.vendor_id),
    related_assignment_id: assignmentId, related_maintenance_id: maintenanceId,
    effective_status: completed ? 'available' : 'repair',
    reason: completed ? 'Repair completed' : 'Sent for repair',
    reference: `Maintenance #${maintenanceId}`, notes: trimStr(data.notes) || null,
    created_by: userId
  }, t);
}

const MAINT_TYPES = ['repair', 'warranty', 'inspection', 'upgrade'];
const MAINT_STATUSES = ['open', 'in_progress', 'completed'];

async function createMaintenance(data, userId) {
  if (!data.asset_id || !trimStr(data.title)) throw new HttpError('Asset and title are required.', 422);
  const type = data.maintenance_type || 'repair';
  if (!MAINT_TYPES.includes(type)) throw new HttpError('Invalid maintenance type.', 422);
  const status = data.status || 'open';
  if (!MAINT_STATUSES.includes(status)) throw new HttpError('Invalid maintenance status.', 422);

  let id;
  await db.tx(async t => {
    const asset = await t.get(
      'SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [parseInt(data.asset_id, 10)]);
    if (!asset) throw new HttpError('Asset not found.', 404);
    id = await t.insert(
      `INSERT INTO asset_maintenance (asset_id, vendor_id, title, maintenance_type, status, start_date,
         completion_date, recurrence, next_due_date, downtime_hours, cost, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [asset.id, nullableId(data.vendor_id), trimStr(data.title), type, status,
        data.start_date || null, data.completion_date || null, data.recurrence || null,
        data.next_due_date || null,
        data.downtime_hours !== '' && data.downtime_hours != null ? data.downtime_hours : null,
        data.cost !== '' && data.cost != null ? data.cost : null,
        trimStr(data.notes), userId]);
    if (type === 'repair') {
      await applyRepairLifecycle(t, asset, id, null, status, data, userId);
    }
  });
  return id;
}

async function updateMaintenance(id, data, userId) {
  if (!trimStr(data.title)) throw new HttpError('Maintenance title is required.', 422);
  await db.tx(async t => {
    const existing = await t.get('SELECT * FROM asset_maintenance WHERE id = $1 FOR UPDATE', [id]);
    if (!existing) throw new HttpError('Maintenance record not found.', 404);
    const asset = await t.get('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [existing.asset_id]);
    let status = data.status || existing.status;
    if (!MAINT_STATUSES.includes(status)) throw new HttpError('Invalid maintenance status.', 422);
    await t.run(
      `UPDATE asset_maintenance SET vendor_id=$1, title=$2, status=$3, start_date=$4, completion_date=$5,
         recurrence=$6, next_due_date=$7, downtime_hours=$8, cost=$9, notes=$10 WHERE id=$11`,
      [nullableId(data.vendor_id), trimStr(data.title), status,
        data.start_date || null, data.completion_date || null, data.recurrence || null, data.next_due_date || null,
        data.downtime_hours !== '' && data.downtime_hours != null ? data.downtime_hours : null,
        data.cost !== '' && data.cost != null ? data.cost : null,
        trimStr(data.notes), id]);
    if (existing.maintenance_type === 'repair' && asset) {
      await applyRepairLifecycle(t, asset, id, existing.status, status, data, userId);
    }
  });
  return true;
}

module.exports = { alerts, auditLogs, maintenanceRecords, maintenanceReferences, createMaintenance, updateMaintenance };
