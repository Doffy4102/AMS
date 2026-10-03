// Port of MovementLedgerService.record(): tolerant stock movement inserts.
const db = require('../core/db');
const { nullableId } = require('../core/helpers');

async function record(data, t = null) {
  const payload = {
    module_key: data.module_key || 'assets',
    item_id: parseInt(data.item_id, 10) || 0,
    movement_type: data.movement_type || null,
    direction: data.direction || 'in',
    quantity: Math.max(1, parseInt(data.quantity, 10) || 1),
    from_location_id: nullableId(data.from_location_id),
    to_location_id: nullableId(data.to_location_id),
    holder_user_id: nullableId(data.holder_user_id),
    vendor_id: nullableId(data.vendor_id),
    related_assignment_id: nullableId(data.related_assignment_id),
    related_maintenance_id: nullableId(data.related_maintenance_id),
    effective_status: data.effective_status || null,
    reason: data.reason || null,
    reference: data.reference || null,
    notes: data.notes || null,
    occurred_at: data.occurred_at || new Date(),
    reversal_of_id: nullableId(data.reversal_of_id),
    is_reversal: data.is_reversal ? true : false,
    created_by: nullableId(data.created_by)
  };
  if (!payload.module_key || !payload.item_id || !payload.direction) return null;

  const cols = Object.keys(payload);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO stock_movements (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
  const values = Object.values(payload);
  const runner = t || db;
  const id = await runner.insert(sql, values);
  return id;
}

module.exports = { record };
