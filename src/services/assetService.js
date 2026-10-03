// Port of AssetRepository (~890 lines) + AssetService (~335 lines).
const crypto = require('crypto');
const db = require('../core/db');
const cache = require('../core/cache');
const audit = require('./auditService');
const authz = require('./authorizationService');
const ledger = require('./movementLedgerService');
const Paginator = require('../core/paginator');
const { nullableId, HttpError, extractCustomFields } = require('../core/helpers');

const BASE_JOINS = `
  FROM assets a
  LEFT JOIN users u ON a.assigned_to = u.id
  LEFT JOIN asset_categories ac ON a.category_id = ac.id
  LEFT JOIN asset_models am ON a.asset_model_id = am.id
  LEFT JOIN manufacturers m ON a.manufacturer_id = m.id
  LEFT JOIN suppliers s ON a.supplier_id = s.id
  LEFT JOIN locations l ON a.location_id = l.id
  LEFT JOIN status_labels sl ON a.status_label_id = sl.id`;

const BASE_SELECT = `
  SELECT a.*,
    u.name AS assigned_to_name,
    ac.name AS category_name,
    am.name AS model_name,
    m.name AS manufacturer_name,
    s.name AS supplier_name,
    l.name AS location_name,
    sl.name AS status_label_name,
    sl.color AS status_label_color`;

function buildFilters(filters, params, startIdx = 1) {
  const where = [];
  let i = startIdx;
  if (filters.search) {
    where.push(`(a.name ILIKE $${i} OR a.asset_tag ILIKE $${i + 1} OR a.serial_number ILIKE $${i + 2})`);
    const term = `%${filters.search}%`;
    params.push(term, term, term);
    i += 3;
  }
  for (const col of ['category_id', 'status_label_id', 'location_id', 'manufacturer_id']) {
    if (filters[col]) {
      where.push(`a.${col} = $${i}`);
      params.push(parseInt(filters[col], 10));
      i += 1;
    }
  }
  if (Array.isArray(filters.location_ids) && filters.location_ids.length) {
    const ph = filters.location_ids.map(() => `$${i++}`);
    where.push(`a.location_id IN (${ph.join(', ')})`);
    params.push(...filters.location_ids.map(Number));
  }
  where.push('a.deleted_at IS NULL');
  return where.join(' AND ');
}

async function count(filters = {}) {
  const params = [];
  const where = buildFilters(filters, params);
  const row = await db.get(`SELECT COUNT(*)::int AS c FROM assets a WHERE ${where}`, params);
  return row.c;
}

async function fetch(limit, offset, filters = {}) {
  const params = [];
  const where = buildFilters(filters, params);
  params.push(limit, offset);
  return db.query(
    `${BASE_SELECT} ${BASE_JOINS} WHERE ${where}
     ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}

async function all() { return fetch(1000, 0, {}); }

async function find(id) {
  return db.get(
    `${BASE_SELECT}, am.default_warranty_months ${BASE_JOINS}
     LEFT JOIN procurement_records pr ON a.procurement_id = pr.id
     WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [parseInt(id, 10)]
  );
}

async function findByLabelToken(token) {
  const row = await db.get('SELECT id FROM assets WHERE label_token = $1 LIMIT 1', [token]);
  return row ? find(row.id) : null;
}

async function findByBarcodeOrTag(code) {
  return db.get(
    `${BASE_SELECT}, sub.name AS sub_location_name ${BASE_JOINS}
     LEFT JOIN sub_locations sub ON a.sub_location_id = sub.id
     WHERE a.deleted_at IS NULL AND (a.asset_tag = $1 OR a.serial_number = $1) LIMIT 1`,
    [code]
  );
}

async function serialNumberExists(serial, excludeId = null) {
  const params = [serial];
  let sql = 'SELECT id FROM assets WHERE serial_number = $1 AND deleted_at IS NULL';
  if (excludeId) { sql += ' AND id != $2'; params.push(excludeId); }
  const row = await db.get(sql + ' LIMIT 1', params);
  return !!row;
}

async function findMany(ids) {
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  return db.query(
    `SELECT a.*, ac.name AS category_name, am.name AS model_name, m.name AS manufacturer_name, l.name AS location_name
     FROM assets a
     LEFT JOIN asset_categories ac ON a.category_id = ac.id
     LEFT JOIN asset_models am ON a.asset_model_id = am.id
     LEFT JOIN manufacturers m ON a.manufacturer_id = m.id
     LEFT JOIN locations l ON a.location_id = l.id
     WHERE a.id IN (${ph}) AND a.deleted_at IS NULL
     ORDER BY a.asset_tag ASC, a.name ASC`,
    ids
  );
}

async function referenceData() {
  const [categories, models, manufacturers, suppliers, locations, statusLabels, users, procurement] = await Promise.all([
    db.query('SELECT * FROM asset_categories ORDER BY name ASC'),
    db.query('SELECT * FROM asset_models ORDER BY name ASC'),
    db.query('SELECT * FROM manufacturers ORDER BY name ASC'),
    db.query('SELECT * FROM suppliers ORDER BY name ASC'),
    db.query('SELECT * FROM locations ORDER BY name ASC'),
    db.query('SELECT * FROM status_labels ORDER BY name ASC'),
    db.query('SELECT id, name, email FROM users WHERE deleted_at IS NULL ORDER BY name ASC'),
    db.query('SELECT id, po_number, invoice_number FROM procurement_records WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100')
  ]);
  return { categories, models, manufacturers, suppliers, locations, status_labels: statusLabels, users, procurement };
}

async function nextAssetTag() {
  const row = await db.get('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM assets');
  let next = parseInt(row.next, 10);
  for (;;) {
    const tag = 'HAMS-' + String(next).padStart(6, '0');
    const exists = await db.get('SELECT id FROM assets WHERE asset_tag = $1', [tag]);
    if (!exists) return tag;
    next += 1;
  }
}

async function statusLabelId(name, t = null) {
  const runner = t || db;
  const row = await runner.get('SELECT id FROM status_labels WHERE name = $1 LIMIT 1', [name]);
  return row ? row.id : null;
}

async function statusLabelIdAny(names, t = null) {
  for (const n of names) {
    const id = await statusLabelId(n, t);
    if (id) return id;
  }
  return null;
}

function normalizeAssetData(data) {
  for (const k of ['name', 'asset_tag', 'serial_number', 'model_number', 'category']) {
    data[k] = String(data[k] ?? '').trim();
  }
  data.status = String(data.status ?? 'available').trim() || 'available';
  if (data.name === '') throw new HttpError('Asset name is required', 422);
  data.custom_fields_data = extractCustomFields(data);
  return data;
}

async function assertLocationAllowed(locationId, user) {
  if (!(await authz.canAccessLocation(locationId, user))) {
    throw new HttpError('You do not have access to manage records in this location.', 403);
  }
}

async function assertSubLocationBelongsToLocation(subLocationId, locationId) {
  const sub = nullableId(subLocationId), loc = nullableId(locationId);
  if (!sub || !loc) return;
  const row = await db.get(
    'SELECT id FROM sub_locations WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL',
    [sub, loc]
  );
  if (!row) throw new HttpError('The selected sub-location does not belong to the selected location.', 422);
}

async function createAsset(data) {
  // "In Stock" label wins on create (mirrors original short-circuit)
  const stockLabel = await statusLabelId('In Stock');
  const labelId = stockLabel || nullableId(data.status_label_id) || await statusLabelId('Ready to Deploy');
  const assetTag = data.asset_tag || await nextAssetTag();
  const labelToken = crypto.randomBytes(16).toString('hex');
  const locationId = nullableId(data.location_id);
  const procurementId = nullableId(data.procurement_id);

  const id = await db.insert(
    `INSERT INTO assets (asset_tag, label_token, name, asset_model_id, category_id, manufacturer_id,
       supplier_id, location_id, sub_location_id, serial_number, model_number, status, status_label_id,
       purchase_date, purchase_cost, warranty_expiry, notes, custom_fields_data, procurement_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      assetTag, labelToken, data.name,
      nullableId(data.asset_model_id), nullableId(data.category_id), nullableId(data.manufacturer_id),
      nullableId(data.supplier_id), locationId, nullableId(data.sub_location_id),
      data.serial_number || null, data.model_number || null,
      'available', labelId,
      data.purchase_date || null,
      data.purchase_cost !== '' && data.purchase_cost !== undefined && data.purchase_cost !== null ? data.purchase_cost : null,
      data.warranty_expiry || null,
      data.notes || null,
      JSON.stringify(data.custom_fields_data || {}),
      procurementId
    ]
  );
  if (id) {
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: 'stock_in', direction: 'in', quantity: 1,
      to_location_id: locationId, effective_status: 'available', reason: 'Asset registration',
      reference: procurementId ? `Procurement #${procurementId}` : null,
      notes: 'Asset entered inventory and is ready for allocation.'
    });
  }
  return id;
}

async function registerAsset(data, user) {
  normalizeAssetData(data);
  await assertLocationAllowed(data.location_id, user);
  await assertSubLocationBelongsToLocation(data.sub_location_id, data.location_id);
  const serial = String(data.serial_number || '').trim();
  if (serial && await serialNumberExists(serial)) {
    throw new HttpError(`Serial number '${serial}' is already in use by another asset.`, 422);
  }
  const id = await createAsset(data);
  if (id) {
    await audit.log(user ? user.id : null, 'ASSET_CREATED',
      `Asset ${data.name || 'Unknown asset'} (SN: ${serial || 'N/A'}) registered.`);
    cache.del('hams_dashboard_metrics');
  }
  return id;
}

// --- Status/maintenance lifecycle automation ---
function isRepairState(labelName, status) {
  const label = String(labelName || '').toLowerCase();
  const st = String(status || '').toLowerCase();
  if (['ready to deploy', 'in stock', 'available'].includes(label)) return false;
  return ['in repair', 'under repair', 'repair'].includes(label) || ['repair', 'under_repair'].includes(st);
}

function isAvailableState(labelName, status) {
  const label = String(labelName || '').toLowerCase();
  const st = String(status || '').toLowerCase();
  return ['ready to deploy', 'in stock', 'available'].includes(label) || ['available', 'in_stock'].includes(st);
}

async function lifecycleSnapshot(id, t) {
  return t.get(
    `SELECT a.*, sl.name AS status_label_name FROM assets a
     LEFT JOIN status_labels sl ON a.status_label_id = sl.id
     WHERE a.id = $1 FOR UPDATE OF a`,
    [id]
  );
}

async function syncMaintenanceFromStatusChange(id, before, data, t, actorId = null) {
  const after = await lifecycleSnapshot(id, t);
  if (!after) return;
  const wasRepair = isRepairState(before.status_label_name, before.status);
  const inRepair = isRepairState(after.status_label_name, after.status);
  const nowAvailable = isAvailableState(after.status_label_name, after.status);

  if (inRepair) {
    let maint = await t.get(
      `SELECT id FROM asset_maintenance WHERE asset_id = $1 AND maintenance_type = 'repair'
       AND status IN ('open', 'in_progress') ORDER BY id DESC LIMIT 1`,
      [id]
    );
    let maintenanceId = maint ? maint.id : null;
    if (!maintenanceId) {
      maintenanceId = await t.insert(
        `INSERT INTO asset_maintenance (asset_id, vendor_id, title, maintenance_type, status, start_date, notes, created_by)
         VALUES ($1, $2, $3, 'repair', 'open', CURRENT_DATE, $4, $5)`,
        [
          id, nullableId(data.supplier_id),
          `Auto repair - ${after.asset_tag || ''} ${after.name || 'Asset'}`.trim(),
          'Automatically created because asset status changed to repair.\n' + (data.notes || ''),
          actorId
        ]
      );
    }
    // Auto-checkin if assigned
    if (after.assigned_to) {
      await t.run(
        `UPDATE assignments SET returned_at = CURRENT_TIMESTAMP, checkin_condition = 'repair',
           checkin_notes = $1
         WHERE id = (SELECT id FROM assignments WHERE asset_id = $2 AND returned_at IS NULL
                     ORDER BY assigned_at DESC, id DESC LIMIT 1)`,
        [`Auto checked-in because asset moved to repair via maintenance #${maintenanceId}`, id]
      );
    }
    const repairLabel = await statusLabelId('In Repair', t);
    await t.run(
      'UPDATE assets SET assigned_to = NULL, status = $1, status_label_id = COALESCE($2, status_label_id) WHERE id = $3',
      ['repair', repairLabel, id]
    );
    if (!wasRepair) {
      await ledger.record({
        module_key: 'assets', item_id: id, movement_type: 'repair_sent', direction: 'out', quantity: 1,
        from_location_id: after.location_id, vendor_id: nullableId(data.supplier_id),
        related_maintenance_id: maintenanceId, effective_status: 'repair',
        reason: 'Status changed to repair', reference: `Maintenance #${maintenanceId}`,
        created_by: actorId
      }, t);
    }
  } else if (wasRepair && nowAvailable) {
    const maint = await t.get(
      `SELECT id, completion_date FROM asset_maintenance WHERE asset_id = $1 AND maintenance_type = 'repair'
       AND status IN ('open', 'in_progress') ORDER BY id DESC LIMIT 1`,
      [id]
    );
    const maintenanceId = maint ? maint.id : null;
    if (maintenanceId) {
      await t.run(
        `UPDATE asset_maintenance SET status = 'completed', completion_date = COALESCE(completion_date, CURRENT_DATE),
           notes = COALESCE(notes, '') || E'\\n' || $1 WHERE id = $2`,
        ['Automatically completed because asset status changed to ready/stock.', maintenanceId]
      );
    }
    const readyLabel = await statusLabelIdAny(['Ready to Deploy', 'In Stock'], t);
    await t.run(
      'UPDATE assets SET assigned_to = NULL, status = $1, status_label_id = COALESCE($2, status_label_id) WHERE id = $3',
      ['available', readyLabel, id]
    );
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: 'repair_received', direction: 'in', quantity: 1,
      to_location_id: after.location_id, related_maintenance_id: maintenanceId, effective_status: 'available',
      reason: 'Status changed to ready/stock', reference: maintenanceId ? `Maintenance #${maintenanceId}` : null,
      created_by: actorId
    }, t);
  }
}

async function updateAsset(id, data, user) {
  normalizeAssetData(data);
  await assertLocationAllowed(data.location_id, user);
  await assertSubLocationBelongsToLocation(data.sub_location_id, data.location_id);
  const serial = String(data.serial_number || '').trim();
  if (serial && await serialNumberExists(serial, id)) {
    throw new HttpError(`Serial number '${serial}' is already in use by another asset.`, 422);
  }
  const before = await find(id);
  if (!before) throw new HttpError('Asset not found.', 404);

  await db.tx(async t => {
    await t.run(
      `UPDATE assets SET asset_tag = $1, name = $2, asset_model_id = $3, category_id = $4,
         manufacturer_id = $5, supplier_id = $6, location_id = $7, sub_location_id = $8,
         serial_number = $9, model_number = $10, status = $11, status_label_id = $12,
         purchase_date = $13, purchase_cost = $14, warranty_expiry = $15, notes = $16,
         custom_fields_data = $17, procurement_id = $18
       WHERE id = $19`,
      [
        data.asset_tag, data.name, nullableId(data.asset_model_id), nullableId(data.category_id),
        nullableId(data.manufacturer_id), nullableId(data.supplier_id), nullableId(data.location_id),
        nullableId(data.sub_location_id), serial || null, data.model_number || null,
        data.status || 'available', nullableId(data.status_label_id),
        data.purchase_date || null,
        data.purchase_cost !== '' && data.purchase_cost !== undefined && data.purchase_cost !== null ? data.purchase_cost : null,
        data.warranty_expiry || null, data.notes || null,
        JSON.stringify(data.custom_fields_data || {}), nullableId(data.procurement_id),
        id
      ]
    );
    await syncMaintenanceFromStatusChange(id, before, data, t, user ? user.id : null);
  });

  await audit.log(user ? user.id : null, 'ASSET_UPDATED', `Asset ${data.name} updated.`);
  cache.del('hams_dashboard_metrics');
  return true;
}

async function deleteAsset(id, user) {
  const asset = await find(id);
  const res = await db.run('UPDATE assets SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  if (res.rowCount > 0) {
    await audit.log(user ? user.id : null, 'ASSET_DELETED', `Asset ${asset ? asset.name : `Asset #${id}`} deleted.`);
    cache.del('hams_dashboard_metrics');
    return true;
  }
  return false;
}

async function checkoutAsset(id, data, user) {
  if (!data.user_id) throw new HttpError('Checkout user is required', 422);
  const actorId = user ? user.id : null;
  await db.tx(async t => {
    const current = await t.get(
      `SELECT a.*, sl.name AS status_label_name FROM assets a
       LEFT JOIN status_labels sl ON a.status_label_id = sl.id
       WHERE a.id = $1 AND a.deleted_at IS NULL FOR UPDATE OF a`,
      [id]
    );
    if (!current) throw new HttpError('Asset not found.', 404);
    if (current.assigned_to) throw new HttpError('Asset is already assigned.', 422);
    const currentStatus = String(current.status_label_name || current.status || '').toLowerCase();
    if (!['available', 'in stock', 'ready to deploy', 'ready'].includes(currentStatus)) {
      throw new HttpError('Only available assets can be checked out.', 422);
    }
    const userId = parseInt(data.user_id, 10);
    const deployedStatus = await statusLabelId('Deployed', t);
    const assignmentId = await t.insert(
      `INSERT INTO assignments (asset_id, user_id, checked_out_by, expected_return_at, checkout_condition, checkout_notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, actorId, data.expected_return_at || null, data.checkout_condition || null, data.checkout_notes || null]
    );
    await t.run(
      "UPDATE assets SET assigned_to = $1, status = 'assigned', status_label_id = $2 WHERE id = $3",
      [userId, deployedStatus, id]
    );
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: 'assigned', direction: 'out', quantity: 1,
      from_location_id: current.location_id, holder_user_id: userId, related_assignment_id: assignmentId,
      effective_status: 'assigned', reason: 'Asset assignment', reference: `Assignment #${assignmentId}`,
      notes: data.checkout_notes || null, created_by: actorId
    }, t);
  });
  await audit.log(actorId, 'ASSET_CHECKED_OUT', `Asset #${id} checked out to user #${data.user_id}.`);
  cache.del('hams_dashboard_metrics');
  return true;
}

async function checkinAsset(id, data, user) {
  const actorId = user ? user.id : null;
  await db.tx(async t => {
    const current = await t.get(
      `SELECT a.*, sl.name AS status_label_name FROM assets a
       LEFT JOIN status_labels sl ON a.status_label_id = sl.id
       WHERE a.id = $1 AND a.deleted_at IS NULL FOR UPDATE OF a`,
      [id]
    );
    if (!current) throw new HttpError('Asset not found.', 404);
    const condition = String(data.checkin_condition || 'good').trim().toLowerCase();
    const needsRepair = ['repair', 'needs repair', 'under_repair'].includes(condition);
    const isDamaged = ['damaged', 'broken'].includes(condition);

    let status = 'available';
    let statusLabel = await statusLabelIdAny(['In Stock', 'Ready to Deploy'], t);
    let movementType = 'returned';
    let effectiveStatus = 'available';
    if (needsRepair) {
      status = 'repair';
      statusLabel = await statusLabelId('In Repair', t);
      movementType = 'repair_sent';
      effectiveStatus = 'repair';
    } else if (isDamaged) {
      status = 'damaged';
      statusLabel = await statusLabelIdAny(['Damaged', 'Broken'], t);
      movementType = 'damaged';
      effectiveStatus = 'damaged';
    }

    await t.run(
      `UPDATE assignments SET returned_at = CURRENT_TIMESTAMP, checked_in_by = $1,
         checkin_condition = $2, checkin_notes = $3
       WHERE id = (SELECT id FROM assignments WHERE asset_id = $4 AND returned_at IS NULL
                   ORDER BY assigned_at DESC, id DESC LIMIT 1)`,
      [actorId, data.checkin_condition || null, data.checkin_notes || null, id]
    );
    const latest = await t.get(
      'SELECT id FROM assignments WHERE asset_id = $1 ORDER BY assigned_at DESC, id DESC LIMIT 1', [id]
    );
    const assignmentId = latest ? latest.id : null;
    await t.run(
      'UPDATE assets SET assigned_to = NULL, status = $1, status_label_id = $2 WHERE id = $3',
      [status, statusLabel, id]
    );
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: movementType,
      direction: status === 'available' ? 'in' : 'out', quantity: 1,
      to_location_id: current.location_id, holder_user_id: current.assigned_to,
      related_assignment_id: assignmentId, effective_status: effectiveStatus,
      reason: status === 'available' ? 'Asset return' : 'Return requires non-available handling',
      reference: assignmentId ? `Assignment #${assignmentId}` : null,
      notes: data.checkin_notes || null, created_by: actorId
    }, t);
  });
  await audit.log(actorId, 'ASSET_CHECKED_IN', `Asset #${id} checked in.`);
  cache.del('hams_dashboard_metrics');
  return true;
}

async function bulkUpdateAssets(ids, data, user) {
  ids = [...new Set(ids.map(Number).filter(Boolean))];
  if (!ids.length || !Object.keys(data).length) return 0;
  if ('location_id' in data) await assertLocationAllowed(data.location_id, user);

  const syncLifecycle = 'status_label_id' in data || 'status' in data;
  let updated = 0;
  await db.tx(async t => {
    let befores = [];
    if (syncLifecycle) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
      befores = await t.query(
        `SELECT a.*, sl.name AS status_label_name FROM assets a
         LEFT JOIN status_labels sl ON a.status_label_id = sl.id
         WHERE a.id IN (${ph}) AND a.deleted_at IS NULL`,
        ids
      );
    }
    const allowed = ['status_label_id', 'location_id', 'status'];
    const sets = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(data)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = $${i++}`);
      params.push(k.endsWith('_id') ? nullableId(v) : v);
    }
    if (!sets.length) return;
    const ph2 = ids.map(() => `$${i++}`).join(', ');
    const res = await t.run(
      `UPDATE assets SET ${sets.join(', ')} WHERE id IN (${ph2}) AND deleted_at IS NULL`,
      [...params, ...ids]
    );
    updated = res.rowCount;
    if (syncLifecycle) {
      for (const before of befores) {
        await syncMaintenanceFromStatusChange(before.id, before, data, t, user ? user.id : null);
      }
    }
  });
  if (updated > 0) {
    await audit.log(user ? user.id : null, 'ASSET_BULK_UPDATED', `${updated} asset(s) updated.`);
    cache.del('hams_dashboard_metrics');
  }
  return updated;
}

async function bulkDeleteAssets(ids, user) {
  ids = [...new Set(ids.map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const res = await db.run(
    `UPDATE assets SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${ph}) AND deleted_at IS NULL`,
    ids
  );
  if (res.rowCount > 0) {
    await audit.log(user ? user.id : null, 'ASSET_BULK_DELETED', `${res.rowCount} asset(s) deleted.`);
    cache.del('hams_dashboard_metrics');
  }
  return res.rowCount;
}

async function assignmentHistory(assetId) {
  return db.query(
    `SELECT a.*, u.name AS user_name, ou.name AS checked_out_by_name, iu.name AS checked_in_by_name
     FROM assignments a
     LEFT JOIN users u ON a.user_id = u.id
     LEFT JOIN users ou ON a.checked_out_by = ou.id
     LEFT JOIN users iu ON a.checked_in_by = iu.id
     WHERE a.asset_id = $1 ORDER BY a.assigned_at DESC`,
    [assetId]
  );
}

async function stockHistory(assetId) {
  return db.query(
    `SELECT sm.*, cu.name AS created_by_name, hu.name AS holder_name, sv.name AS vendor_name,
            fl.name AS from_location_name, tl.name AS to_location_name
     FROM stock_movements sm
     LEFT JOIN users cu ON sm.created_by = cu.id
     LEFT JOIN users hu ON sm.holder_user_id = hu.id
     LEFT JOIN suppliers sv ON sm.vendor_id = sv.id
     LEFT JOIN locations fl ON sm.from_location_id = fl.id
     LEFT JOIN locations tl ON sm.to_location_id = tl.id
     WHERE sm.module_key = 'assets' AND sm.item_id = $1
     ORDER BY COALESCE(sm.occurred_at, sm.created_at) DESC, sm.id DESC`,
    [assetId]
  );
}

// Service-level wrappers with location scoping
async function page(pageNum = 1, perPage = 15, filters = {}, user = null) {
  const scoped = await authz.applyLocationScope(filters, user);
  const total = await count(scoped);
  const paginator = new Paginator(total, perPage, pageNum);
  const items = await fetch(perPage, paginator.offset, scoped);
  return { items, paginator, total };
}

async function getAsset(id, user) {
  const asset = await find(id);
  if (asset && !(await authz.canAccessLocation(asset.location_id, user))) return false;
  return asset;
}

async function getReferenceData(user) {
  const refs = await referenceData();
  const scope = await authz.locationScopeFor(user);
  if (!scope.global) {
    refs.locations = refs.locations.filter(l => scope.location_ids.includes(parseInt(l.id, 10)));
  }
  return refs;
}

async function getLabelAssets(ids, user) {
  const assets = await findMany(ids.map(Number).filter(Boolean));
  const out = [];
  for (const a of assets) {
    if (await authz.canAccessLocation(a.location_id, user)) out.push(a);
  }
  return out;
}

function calculateDepreciation(asset) {
  if (!asset.purchase_cost || !asset.purchase_date || !asset.depreciation_months) return null;
  const cost = parseFloat(asset.purchase_cost);
  const salvage = parseFloat(asset.salvage_value || 0);
  const months = parseInt(asset.depreciation_months, 10);
  const pd = new Date(asset.purchase_date);
  const now = new Date();
  let monthsOwned = (now.getFullYear() - pd.getFullYear()) * 12 + (now.getMonth() - pd.getMonth());
  if (now.getDate() < pd.getDate()) monthsOwned -= 1;
  monthsOwned = Math.max(0, monthsOwned);
  if (monthsOwned >= months) return salvage;
  const monthly = (cost - salvage) / months;
  return Math.max(salvage, cost - monthly * monthsOwned);
}

// Portal helpers
async function getAssignedToUser(userId) {
  return db.query(
    `SELECT a.*, ac.name AS category_name, m.name AS manufacturer_name, am.name AS model_name,
            sl.name AS status_name, sl.color AS status_color
     FROM assets a
     LEFT JOIN asset_categories ac ON a.category_id = ac.id
     LEFT JOIN manufacturers m ON a.manufacturer_id = m.id
     LEFT JOIN asset_models am ON a.asset_model_id = am.id
     LEFT JOIN status_labels sl ON a.status_label_id = sl.id
     WHERE a.assigned_to = $1 AND a.deleted_at IS NULL ORDER BY a.name ASC`,
    [userId]
  );
}

async function getAssignedAccessories(userId) {
  return db.query(
    `SELECT aa.id AS assignment_id, aa.qty, aa.assigned_at, aa.notes,
            acc.name, acc.model_number, ac.name AS category_name, m.name AS manufacturer_name
     FROM accessory_assignments aa
     JOIN accessories acc ON aa.accessory_id = acc.id
     LEFT JOIN asset_categories ac ON acc.category_id = ac.id
     LEFT JOIN manufacturers m ON acc.manufacturer_id = m.id
     WHERE aa.user_id = $1 AND aa.returned_at IS NULL ORDER BY acc.name ASC`,
    [userId]
  );
}

async function getAssignedLicenses(userId) {
  return db.query(
    `SELECT la.id AS assignment_id, la.assigned_at, la.notes,
            lic.name, lic.expiration_date, m.name AS manufacturer_name,
            a.name AS asset_name, a.asset_tag
     FROM license_assignments la
     JOIN licenses lic ON la.license_id = lic.id
     LEFT JOIN manufacturers m ON lic.manufacturer_id = m.id
     LEFT JOIN assets a ON la.asset_id = a.id
     WHERE (la.user_id = $1 OR la.asset_id IN (SELECT id FROM assets WHERE assigned_to = $1 AND deleted_at IS NULL))
       AND la.revoked_at IS NULL
     ORDER BY lic.name ASC`,
    [userId]
  );
}

async function getAssignedComponents(userId) {
  return db.query(
    `SELECT ca.id AS assignment_id, ca.qty, ca.assigned_at, ca.notes,
            comp.name, comp.serial_number, ac.name AS category_name, m.name AS manufacturer_name,
            a.name AS asset_name, a.asset_tag
     FROM component_assignments ca
     JOIN components comp ON ca.component_id = comp.id
     JOIN assets a ON ca.asset_id = a.id
     LEFT JOIN asset_categories ac ON comp.category_id = ac.id
     LEFT JOIN manufacturers m ON comp.manufacturer_id = m.id
     WHERE a.assigned_to = $1 AND a.deleted_at IS NULL AND ca.removed_at IS NULL
     ORDER BY comp.name ASC`,
    [userId]
  );
}

module.exports = {
  count, fetch, all, find, findByLabelToken, findByBarcodeOrTag, findMany,
  referenceData, nextAssetTag, statusLabelId, statusLabelIdAny, serialNumberExists,
  registerAsset, createAsset, updateAsset, deleteAsset, checkoutAsset, checkinAsset,
  bulkUpdateAssets, bulkDeleteAssets, assignmentHistory, stockHistory,
  page, getAsset, getReferenceData, getLabelAssets, calculateDepreciation,
  getAssignedToUser, getAssignedAccessories, getAssignedLicenses, getAssignedComponents,
  syncMaintenanceFromStatusChange
};
