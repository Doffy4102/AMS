// Port of InventoryWorkflowService: assign / return / history for inventory types.
const db = require('../core/db');
const audit = require('./auditService');
const ledger = require('./movementLedgerService');
const { nullableId, HttpError, trimStr, intOr } = require('../core/helpers');

async function decrement(t, table, col, id, qty) {
  const row = await t.get(`SELECT ${col} AS available FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!row || intOr(row.available) < qty) throw new HttpError('Not enough stock available.', 422);
  await t.run(`UPDATE ${table} SET ${col} = ${col} - $1 WHERE id = $2`, [qty, id]);
}

async function increment(t, table, col, id, qty) {
  await t.run(`UPDATE ${table} SET ${col} = ${col} + $1 WHERE id = $2`, [qty, id]);
}

async function note(t, moduleKey, itemId, action, subjectId, quantity, notes, createdBy) {
  await t.run(
    `INSERT INTO inventory_workflow_notes (module_key, item_id, action, subject_id, quantity, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [moduleKey, itemId, action, subjectId || null, quantity, notes, createdBy]
  );
}

async function assign(type, id, data, actorId) {
  const qty = Math.max(1, intOr(data.quantity, 1));
  const notes = trimStr(data.notes);
  id = parseInt(id, 10);

  await db.tx(async t => {
    if (type === 'accessories') {
      const userId = intOr(data.user_id, 0);
      if (userId <= 0) throw new HttpError('User is required.', 422);
      await decrement(t, 'accessories', 'available_qty', id, qty);
      await t.run('INSERT INTO accessory_assignments (accessory_id, user_id, qty, notes) VALUES ($1,$2,$3,$4)',
        [id, userId, qty, notes]);
    } else if (type === 'consumables') {
      const userId = intOr(data.user_id, 0);
      if (userId <= 0) throw new HttpError('User is required.', 422);
      await decrement(t, 'consumables', 'remaining_qty', id, qty);
      await t.run('INSERT INTO consumable_issues (consumable_id, user_id, qty, notes) VALUES ($1,$2,$3,$4)',
        [id, userId, qty, notes]);
    } else if (type === 'components') {
      const assetId = intOr(data.asset_id, 0);
      if (assetId <= 0) throw new HttpError('Asset is required.', 422);
      await decrement(t, 'components', 'available_qty', id, qty);
      await t.run('INSERT INTO component_assignments (component_id, asset_id, qty, notes) VALUES ($1,$2,$3,$4)',
        [id, assetId, qty, notes]);
    } else if (type === 'licenses') {
      const userId = nullableId(data.user_id);
      const assetId = nullableId(data.asset_id);
      if (!userId && !assetId) throw new HttpError('User or asset is required.', 422);
      await decrement(t, 'licenses', 'available_seats', id, 1);
      await t.run('INSERT INTO license_assignments (license_id, user_id, asset_id, notes) VALUES ($1,$2,$3,$4)',
        [id, userId, assetId, notes]);
    } else {
      throw new HttpError('This inventory type does not support assignments yet.', 422);
    }

    await note(t, type, id, 'assigned', intOr(data.user_id, 0) || intOr(data.asset_id, 0) || null, qty, notes, actorId);

    if (type !== 'licenses') {
      await ledger.record({
        module_key: type, item_id: id,
        movement_type: type === 'consumables' ? 'issued' : 'assigned',
        direction: 'out', quantity: qty,
        holder_user_id: nullableId(data.user_id),
        effective_status: 'assigned', reason: 'Inventory assignment',
        reference: data.asset_id ? `Asset #${intOr(data.asset_id)}` : null,
        notes, created_by: actorId
      }, t);
    }
  });

  await audit.log(actorId, 'INVENTORY_ASSIGNED', `Assigned ${type} #${id}, quantity ${qty}.`);
  return true;
}

async function returnAssignment(type, assignmentId, actorId) {
  assignmentId = parseInt(assignmentId, 10);
  let movement = null;

  await db.tx(async t => {
    if (type === 'accessories') {
      const row = await t.get('SELECT * FROM accessory_assignments WHERE id = $1 AND returned_at IS NULL FOR UPDATE', [assignmentId]);
      if (!row) throw new HttpError('Open assignment not found.', 404);
      await increment(t, 'accessories', 'available_qty', row.accessory_id, intOr(row.qty, 1));
      await t.run('UPDATE accessory_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = $1', [assignmentId]);
      movement = { item_id: row.accessory_id, quantity: intOr(row.qty, 1), user_id: row.user_id };
    } else if (type === 'components') {
      const row = await t.get('SELECT * FROM component_assignments WHERE id = $1 AND removed_at IS NULL FOR UPDATE', [assignmentId]);
      if (!row) throw new HttpError('Open assignment not found.', 404);
      await increment(t, 'components', 'available_qty', row.component_id, intOr(row.qty, 1));
      await t.run('UPDATE component_assignments SET removed_at = CURRENT_TIMESTAMP WHERE id = $1', [assignmentId]);
      movement = { item_id: row.component_id, quantity: intOr(row.qty, 1) };
    } else if (type === 'licenses') {
      const row = await t.get('SELECT * FROM license_assignments WHERE id = $1 AND revoked_at IS NULL FOR UPDATE', [assignmentId]);
      if (!row) throw new HttpError('Open assignment not found.', 404);
      await increment(t, 'licenses', 'available_seats', row.license_id, 1);
      await t.run('UPDATE license_assignments SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1', [assignmentId]);
      movement = { item_id: row.license_id, quantity: 1, user_id: row.user_id };
    } else {
      throw new HttpError('This workflow cannot be returned.', 422);
    }

    if (type !== 'licenses') {
      await ledger.record({
        module_key: type, item_id: movement.item_id, movement_type: 'returned', direction: 'in',
        quantity: movement.quantity, holder_user_id: nullableId(movement.user_id),
        effective_status: 'available', reason: 'Inventory return',
        reference: `Assignment #${assignmentId}`, created_by: actorId
      }, t);
    }
  });

  await audit.log(actorId, 'INVENTORY_RETURNED', `Returned ${type} assignment #${assignmentId}.`);
  return true;
}

async function getItem(type, id) {
  if (['accessories', 'consumables', 'components'].includes(type)) {
    return db.get(
      `SELECT t.*, m.name AS manufacturer_name, c.name AS category_name
       FROM ${type} t
       LEFT JOIN manufacturers m ON t.manufacturer_id = m.id
       LEFT JOIN asset_categories c ON t.category_id = c.id
       WHERE t.id = $1`, [id]);
  }
  if (type === 'licenses') {
    return db.get(
      `SELECT t.*, m.name AS manufacturer_name FROM licenses t
       LEFT JOIN manufacturers m ON t.manufacturer_id = m.id WHERE t.id = $1`, [id]);
  }
  return null;
}

async function history(type, id) {
  id = parseInt(id, 10);
  if (type === 'accessories') {
    const rows = await db.query(
      `SELECT aa.id, aa.qty, aa.assigned_at AS created_at, aa.returned_at, u.name AS user_name
       FROM accessory_assignments aa LEFT JOIN users u ON aa.user_id = u.id
       WHERE aa.accessory_id = $1 ORDER BY aa.assigned_at DESC`, [id]);
    return rows.map(r => ({ ...r, action: 'Assigned', subject: r.user_name || 'Unknown User' }));
  }
  if (type === 'consumables') {
    const rows = await db.query(
      `SELECT ci.id, ci.qty, ci.issued_at AS created_at, NULL AS returned_at, u.name AS user_name
       FROM consumable_issues ci LEFT JOIN users u ON ci.user_id = u.id
       WHERE ci.consumable_id = $1 ORDER BY ci.issued_at DESC`, [id]);
    return rows.map(r => ({ ...r, action: 'Issued', subject: r.user_name || 'Unknown User' }));
  }
  if (type === 'components') {
    const rows = await db.query(
      `SELECT ca.id, ca.qty, ca.assigned_at AS created_at, ca.removed_at AS returned_at,
              a.name AS asset_name, a.asset_tag, u.name AS user_name
       FROM component_assignments ca
       LEFT JOIN assets a ON ca.asset_id = a.id
       LEFT JOIN users u ON a.assigned_to = u.id
       WHERE ca.component_id = $1 ORDER BY ca.assigned_at DESC`, [id]);
    return rows.map(r => ({
      ...r, action: 'Installed',
      subject: `${r.asset_name || 'Unknown Asset'} (${r.asset_tag || 'N/A'})` +
        (r.user_name ? ` - Assigned to: ${r.user_name}` : ' - Unassigned')
    }));
  }
  if (type === 'licenses') {
    const rows = await db.query(
      `SELECT la.id, 1 AS qty, la.assigned_at AS created_at, la.revoked_at AS returned_at,
              u.name AS user_name, a.name AS asset_name, a.asset_tag, au.name AS asset_user_name
       FROM license_assignments la
       LEFT JOIN users u ON la.user_id = u.id
       LEFT JOIN assets a ON la.asset_id = a.id
       LEFT JOIN users au ON a.assigned_to = au.id
       WHERE la.license_id = $1 ORDER BY la.assigned_at DESC`, [id]);
    return rows.map(r => {
      let subject = 'Unknown';
      if (r.user_name) subject = `User: ${r.user_name}`;
      else if (r.asset_name) {
        subject = `Asset: ${r.asset_name} (${r.asset_tag || 'N/A'})` +
          (r.asset_user_name ? ` - Assigned to: ${r.asset_user_name}` : ' - Unassigned');
      }
      return { ...r, action: 'Assigned', subject };
    });
  }
  return [];
}

module.exports = { assign, returnAssignment, history, getItem };
