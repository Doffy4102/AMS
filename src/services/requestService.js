// Port of RequestService: asset requests with approval + auto-checkout.
const db = require('../core/db');
const ledger = require('./movementLedgerService');
const notifications = require('./notificationService');
const { nullableId, HttpError, trimStr } = require('../core/helpers');

async function references() {
  const [assets, models, categories] = await Promise.all([
    db.query(`SELECT id, name, asset_tag FROM assets WHERE assigned_to IS NULL AND deleted_at IS NULL ORDER BY name ASC LIMIT 1000`),
    db.query('SELECT id, name, model_number FROM asset_models ORDER BY name ASC LIMIT 1000'),
    db.query('SELECT id, name FROM asset_categories ORDER BY name ASC LIMIT 1000')
  ]);
  return { assets, models, categories };
}

async function mine(userId) {
  return db.query(
    `SELECT r.*, a.name AS asset_name, a.asset_tag, am.name AS model_name, ac.name AS category_name
     FROM asset_requests r
     LEFT JOIN assets a ON r.asset_id = a.id
     LEFT JOIN asset_models am ON r.asset_model_id = am.id
     LEFT JOIN asset_categories ac ON r.category_id = ac.id
     WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    [userId]
  );
}

async function all() {
  return db.query(
    `SELECT r.*, u.name AS user_name, a.name AS asset_name, a.asset_tag,
            am.name AS model_name, ac.name AS category_name, rev.name AS reviewer_name
     FROM asset_requests r
     JOIN users u ON r.user_id = u.id
     LEFT JOIN assets a ON r.asset_id = a.id
     LEFT JOIN asset_models am ON r.asset_model_id = am.id
     LEFT JOIN asset_categories ac ON r.category_id = ac.id
     LEFT JOIN users rev ON r.reviewed_by = rev.id
     ORDER BY r.created_at DESC LIMIT 500`
  );
}

async function create(data, userId) {
  const title = trimStr(data.title);
  if (!title) throw new HttpError('Request title is required.', 422);
  const id = await db.insert(
    `INSERT INTO asset_requests (user_id, asset_id, asset_model_id, category_id, title, business_justification)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, nullableId(data.asset_id), nullableId(data.asset_model_id), nullableId(data.category_id),
      title, trimStr(data.business_justification)]
  );
  if (id) {
    try {
      const user = await db.get('SELECT name FROM users WHERE id = $1', [userId]);
      const userName = user ? user.name : 'An employee';
      await notifications.sendToAdmins('new_request', 'New Asset Request Submitted',
        `${userName} has submitted a new asset request: '${title}'.`);
    } catch (_) { /* swallow */ }
  }
  return id;
}

async function checkoutApprovedAsset(t, requestId, reviewerId) {
  const request = await t.get('SELECT * FROM asset_requests WHERE id = $1 FOR UPDATE', [requestId]);
  if (!request || !request.asset_id) return;
  const asset = await t.get(
    `SELECT a.*, sl.name AS status_label_name FROM assets a
     LEFT JOIN status_labels sl ON a.status_label_id = sl.id
     WHERE a.id = $1 AND a.deleted_at IS NULL FOR UPDATE OF a`,
    [request.asset_id]
  );
  if (!asset || asset.assigned_to) return;
  const currentStatus = String(asset.status_label_name || asset.status || '').toLowerCase();
  if (!['available', 'in stock', 'ready to deploy', 'ready'].includes(currentStatus)) return;

  const assignmentId = await t.insert(
    `INSERT INTO assignments (asset_id, user_id, checked_out_by, checkout_notes) VALUES ($1, $2, $3, $4)`,
    [asset.id, request.user_id, reviewerId, `Checked out from approved request #${requestId}`]
  );
  const deployed = await t.get(`SELECT id FROM status_labels WHERE name = 'Deployed' LIMIT 1`);
  await t.run(
    "UPDATE assets SET assigned_to = $1, status = 'assigned', status_label_id = $2 WHERE id = $3",
    [request.user_id, deployed ? deployed.id : null, asset.id]
  );
  await t.run(
    `UPDATE asset_requests SET status = 'fulfilled', fulfilled_asset_id = $1, fulfilled_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [asset.id, requestId]
  );
  await ledger.record({
    module_key: 'assets', item_id: asset.id, movement_type: 'assigned', direction: 'out', quantity: 1,
    holder_user_id: request.user_id, related_assignment_id: assignmentId, effective_status: 'assigned',
    reason: 'Approved asset request', reference: `Request #${requestId}`,
    notes: `Checked out from approved request #${requestId}`, created_by: reviewerId
  }, t);
}

async function review(id, status, reviewerId, notes) {
  if (!['approved', 'rejected'].includes(status)) throw new HttpError('Invalid request status.', 422);
  let request;
  await db.tx(async t => {
    await t.run(
      `UPDATE asset_requests SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_notes = $3 WHERE id = $4`,
      [status, reviewerId, trimStr(notes), id]
    );
    if (status === 'approved') await checkoutApprovedAsset(t, id, reviewerId);
    request = await t.get('SELECT * FROM asset_requests WHERE id = $1', [id]);
  });
  if (request) {
    try {
      const cap = status.charAt(0).toUpperCase() + status.slice(1);
      let message = `Your request for '${request.title}' has been ${status} by the administrator.`;
      if (trimStr(notes)) message += `\n\nReview Notes:\n${trimStr(notes)}`;
      await notifications.send(request.user_id, 'request_review', `Asset Request ${cap}: ${request.title}`, message);
    } catch (_) { /* swallow */ }
  }
  return true;
}

module.exports = { references, mine, all, create, review };
