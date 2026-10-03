// Port of PlatformService: dashboard metrics (cached 300s), reports, quick exports,
// purchase orders / reservations / attachments.
const db = require('../core/db');
const cache = require('../core/cache');
const { nullableId, HttpError, trimStr, intOr } = require('../core/helpers');

async function dashboard() {
  const cached = cache.get('hams_dashboard_metrics');
  if (cached) return cached;

  const [assets, users, assigned, repair, warranty, recent, byCategory, byStatus, health, trend, byDepartment] = await Promise.all([
    db.get('SELECT COUNT(*)::int AS c FROM assets WHERE deleted_at IS NULL'),
    db.get('SELECT COUNT(*)::int AS c FROM users WHERE deleted_at IS NULL'),
    db.get('SELECT COUNT(*)::int AS c FROM assets WHERE assigned_to IS NOT NULL AND deleted_at IS NULL'),
    db.get(`SELECT COUNT(*)::int AS c FROM assets WHERE deleted_at IS NULL
            AND (status = 'repair' OR status_label_id IN (SELECT id FROM status_labels WHERE name = 'In Repair'))`),
    db.get(`SELECT COUNT(*)::int AS c FROM assets WHERE deleted_at IS NULL
            AND warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'`),
    db.query(`SELECT l.*, u.name AS user_name FROM activity_logs l
              LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC LIMIT 5`),
    db.query(`SELECT COALESCE(ac.name, a.category, 'Uncategorized') AS label, COUNT(*)::int AS total
              FROM assets a LEFT JOIN asset_categories ac ON a.category_id = ac.id
              WHERE a.deleted_at IS NULL GROUP BY label ORDER BY total DESC LIMIT 8`),
    db.query(`SELECT COALESCE(sl.name, a.status, 'Unknown') AS label, COUNT(*)::int AS total
              FROM assets a LEFT JOIN status_labels sl ON a.status_label_id = sl.id
              WHERE a.deleted_at IS NULL GROUP BY label ORDER BY total DESC`),
    db.get(`SELECT COALESCE(ROUND(COUNT(CASE WHEN sl.type IN ('deployable', 'deployed') THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0)), 0)::int AS pct
            FROM assets a LEFT JOIN status_labels sl ON a.status_label_id = sl.id WHERE a.deleted_at IS NULL`),
    db.query(`SELECT TO_CHAR(created_at, 'Mon YYYY') AS month, COUNT(*)::int AS total,
                     EXTRACT(YEAR FROM created_at) AS y, EXTRACT(MONTH FROM created_at) AS m
              FROM assets WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '6 months'
              GROUP BY y, m, month ORDER BY y, m`),
    db.query(`SELECT COALESCE(d.name, 'Unassigned') AS label, COUNT(a.id)::int AS total
              FROM assets a
              LEFT JOIN users u ON a.assigned_to = u.id
              LEFT JOIN departments d ON u.department_id = d.id
              WHERE a.deleted_at IS NULL GROUP BY label ORDER BY total DESC`)
  ]);

  const [acc, cons, comp, lic] = await Promise.all([
    db.get(`SELECT COALESCE(SUM(available_qty),0)::int AS available, COALESCE(SUM(total_qty),0)::int AS total FROM accessories WHERE deleted_at IS NULL`),
    db.get(`SELECT COALESCE(SUM(remaining_qty),0)::int AS available, COALESCE(SUM(total_qty),0)::int AS total FROM consumables WHERE deleted_at IS NULL`),
    db.get(`SELECT COALESCE(SUM(available_qty),0)::int AS available, COALESCE(SUM(total_qty),0)::int AS total FROM components WHERE deleted_at IS NULL`),
    db.get(`SELECT COALESCE(SUM(available_seats),0)::int AS available, COALESCE(SUM(seats),0)::int AS total FROM licenses WHERE deleted_at IS NULL`)
  ]);

  const data = {
    assets: assets.c, users: users.c, assigned: assigned.c, repair: repair.c,
    warranty_expiring: warranty.c,
    recent,
    by_category: byCategory,
    by_status: byStatus,
    inventory_stock: {
      Accessories: { available: acc.available, total: acc.total },
      Consumables: { available: cons.available, total: cons.total },
      Components: { available: comp.available, total: comp.total },
      Licenses: { available: lic.available, total: lic.total }
    },
    health: health.pct,
    trend: trend.map(r => ({ month: r.month, total: r.total })),
    by_department: byDepartment
  };
  cache.set('hams_dashboard_metrics', data, 300);
  return data;
}

async function reports() {
  const [assetsByStatus, assetsByLocation, depreciation, aging, checkouts, stockMovements, imports] = await Promise.all([
    db.query(`SELECT COALESCE(sl.name, a.status, 'Unknown') AS label, COUNT(*)::int AS total
              FROM assets a LEFT JOIN status_labels sl ON a.status_label_id = sl.id
              WHERE a.deleted_at IS NULL GROUP BY label ORDER BY total DESC`),
    db.query(`SELECT COALESCE(l.name, 'Unassigned') AS label, COUNT(*)::int AS total
              FROM assets a LEFT JOIN locations l ON a.location_id = l.id
              WHERE a.deleted_at IS NULL GROUP BY label ORDER BY total DESC`),
    db.query(`SELECT id, name, asset_tag, purchase_cost, depreciation_months, salvage_value, purchase_date
              FROM assets WHERE purchase_cost IS NOT NULL AND deleted_at IS NULL
              ORDER BY purchase_date DESC LIMIT 25`),
    db.query(`SELECT id, name, asset_tag, purchase_date,
                     (EXTRACT(YEAR FROM AGE(CURRENT_DATE, purchase_date)) * 12 + EXTRACT(MONTH FROM AGE(CURRENT_DATE, purchase_date)))::int AS age_months
              FROM assets WHERE purchase_date IS NOT NULL AND deleted_at IS NULL
              ORDER BY purchase_date ASC LIMIT 25`),
    db.query(`SELECT ass.assigned_at, ass.returned_at, a.name AS asset_name, a.asset_tag, u.name AS user_name
              FROM assignments ass
              LEFT JOIN assets a ON ass.asset_id = a.id
              LEFT JOIN users u ON ass.user_id = u.id
              ORDER BY ass.assigned_at DESC LIMIT 25`),
    db.query(`SELECT sm.created_at, sm.module_key, sm.direction, sm.quantity, sm.reason,
                     COALESCE(u.name, 'System') AS user_name
              FROM stock_movements sm LEFT JOIN users u ON sm.created_by = u.id
              ORDER BY sm.created_at DESC LIMIT 25`),
    db.query('SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 20')
  ]);
  return {
    assets_by_status: assetsByStatus, assets_by_location: assetsByLocation,
    depreciation, aging, checkouts, stock_movements: stockMovements, imports
  };
}

// Quick export types (/export/{type})
async function exportRows(type) {
  switch (type) {
    case 'assets':
      return db.query(`SELECT asset_tag, name, serial_number, model_number, status, purchase_date, warranty_expiry
                       FROM assets WHERE deleted_at IS NULL ORDER BY id`);
    case 'users':
      return db.query(`SELECT name, email, role, status, employee_id FROM users WHERE deleted_at IS NULL ORDER BY id`);
    case 'licenses':
      return db.query(`SELECT name, seats, available_seats, expiration_date FROM licenses WHERE deleted_at IS NULL ORDER BY id`);
    case 'audit_logs':
      return db.query(`SELECT l.created_at, u.name AS "user", l.action, l.description
                       FROM activity_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC`);
    default:
      throw new HttpError('Unknown export type', 400);
  }
}

// Advanced page
async function purchaseOrders() {
  return db.query(`SELECT po.*, s.name AS supplier_name FROM purchase_orders po
                   LEFT JOIN suppliers s ON po.supplier_id = s.id
                   ORDER BY po.created_at DESC LIMIT 250`);
}

async function reservations() {
  return db.query(`SELECT r.*, a.name AS asset_name, a.asset_tag, u.name AS user_name
                   FROM asset_reservations r
                   JOIN assets a ON r.asset_id = a.id
                   JOIN users u ON r.user_id = u.id
                   ORDER BY r.created_at DESC LIMIT 250`);
}

async function attachments() {
  return db.query(
    `SELECT att.*, up.name AS uploaded_by_name,
       CASE att.entity_type
         WHEN 'asset' THEN (SELECT a.name || ' (' || COALESCE(a.asset_tag, '') || ')' FROM assets a WHERE a.id = att.entity_id)
         WHEN 'license' THEN (SELECT l.name FROM licenses l WHERE l.id = att.entity_id)
         WHEN 'maintenance' THEN (SELECT m.title FROM asset_maintenance m WHERE m.id = att.entity_id)
         ELSE att.entity_type || ' #' || att.entity_id
       END AS target_name
     FROM attachments att
     LEFT JOIN users up ON att.uploaded_by = up.id
     ORDER BY att.created_at DESC LIMIT 250`);
}

async function advancedReferences() {
  const [assets, users, suppliers] = await Promise.all([
    db.query('SELECT id, name, asset_tag FROM assets WHERE deleted_at IS NULL ORDER BY name ASC LIMIT 1000'),
    db.query('SELECT id, name, email FROM users WHERE deleted_at IS NULL ORDER BY name ASC LIMIT 1000'),
    db.query('SELECT id, name FROM suppliers ORDER BY name ASC LIMIT 1000')
  ]);
  return { assets, users, suppliers };
}

async function createPurchaseOrder(data, userId) {
  return db.insert(
    `INSERT INTO purchase_orders (po_number, supplier_id, status, order_date, expected_date, total_amount, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [trimStr(data.po_number), nullableId(data.supplier_id), data.status || 'draft',
      data.order_date || null, data.expected_date || null,
      data.total_amount !== '' && data.total_amount != null ? data.total_amount : null,
      trimStr(data.notes), userId]);
}

async function createReservation(data, userId) {
  return db.insert(
    `INSERT INTO asset_reservations (asset_id, user_id, reserved_from, reserved_until, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [intOr(data.asset_id, 0), intOr(data.user_id, 0),
      data.reserved_from || null, data.reserved_until || null, trimStr(data.notes), userId]);
}

async function createAttachment(data, userId) {
  return db.insert(
    `INSERT INTO attachments (entity_type, entity_id, title, file_url, attachment_type, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [data.entity_type || 'asset', intOr(data.entity_id, 0), trimStr(data.title),
      trimStr(data.file_url), data.attachment_type || 'document', trimStr(data.notes), userId]);
}

module.exports = {
  dashboard, reports, exportRows,
  purchaseOrders, reservations, attachments, advancedReferences,
  createPurchaseOrder, createReservation, createAttachment
};
