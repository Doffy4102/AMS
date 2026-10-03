// New Joinee onboarding: allocation agent + engineer approval workflow.
// The agent DRAFTS a laptop + headphone per designation rules against live
// available inventory; it never assigns anything itself. An engineer reviews
// (and may edit) the draft, then "Allocate" finalizes through the existing
// writers — assetService.checkoutAsset for the laptop (assignments table,
// movement ledger, audit, dashboard cache) and inventoryWorkflowService.assign
// for the headphone (accessory_assignments + available_qty) — so approved
// allocations show up in the Assets / Accessories tabs like any other checkout.
const db = require('../core/db');
const audit = require('./auditService');
const assetService = require('./assetService');
const inventoryWorkflow = require('./inventoryWorkflowService');
const { HttpError, intOr } = require('../core/helpers');

const LAPTOP_CATEGORY = 'Laptop';
const HEADPHONE_CATEGORY = 'Headphone';

// A laptop counts as premium/high-end when its model reads as an Apple or
// X1-class machine. Used both by the agent and the edit dropdown's
// designation-based filtering (with an Exception toggle to show all).
const PREMIUM_PATTERN = /(macbook|x1 carbon)/i;

// Business rules: designation -> preferred laptop models (in priority order,
// matched against assets.model_number) and preferred headphone models.
// premiumOnly drives the edit dropdown's initial premium-only filtering.
const ALLOCATION_RULES = {
  'Senior Director': {
    label: 'Premium MacBook',
    premiumOnly: true,
    laptops: ['MacBook Pro 16', 'MacBook Pro 14', 'MacBook Pro 13'],
    headphones: ['Sennheiser', 'WH1022', 'WH125']
  },
  'AVP': {
    label: 'MacBook',
    premiumOnly: true,
    laptops: ['MacBook Pro 14', 'MacBook Pro 13', 'MacBook'],
    headphones: ['Sennheiser', 'WH1022', 'WH125']
  },
  'Consultant': {
    label: 'High-performance business laptop',
    premiumOnly: false,
    laptops: ['ThinkPad X1', 'T14 Gen', 'ThinkPad-T14'],
    headphones: ['WH1022', 'WH125']
  },
  'Engineer': {
    label: 'Standard developer laptop',
    premiumOnly: false,
    laptops: ['Thinkpad-L14', 'ThinkPad-L15', 'ThinkPad-L13'],
    headphones: ['WH125', 'WH1022']
  },
  'Fresher': {
    label: 'Standard laptop',
    premiumOnly: false,
    laptops: ['ThinkBook', 'V130', 'V 130'],
    headphones: ['WH125']
  }
};
const DEFAULT_RULE = ALLOCATION_RULES['Engineer'];

function ruleFor(designation) {
  return ALLOCATION_RULES[designation] || DEFAULT_RULE;
}

// Laptops still free to draft: available, unassigned, AT THE JOINEE'S LOCATION,
// and not already held by another joinee's un-approved draft. Falls back from
// the designation's preferred models to ANY available laptop at that location
// (a location-matched standard machine beats no draft at all); returns null
// only when the location truly has nothing.
async function pickLaptop(t, patterns, excludeJoineeId, locationId) {
  if (!locationId) return null;
  for (const p of [...patterns, '']) {
    const row = await t.get(
      `SELECT a.id FROM assets a
        JOIN asset_categories c ON a.category_id = c.id
       WHERE c.name = $1 AND a.deleted_at IS NULL AND a.assigned_to IS NULL
         AND LOWER(a.status) = 'available' AND a.location_id = $4
         AND a.model_number ILIKE $2
         AND a.id NOT IN (
           SELECT draft_laptop_asset_id FROM new_joinees
            WHERE draft_laptop_asset_id IS NOT NULL
              AND allocation_status = 'draft' AND id <> $3)
       ORDER BY a.id LIMIT 1`,
      [LAPTOP_CATEGORY, `%${p}%`, excludeJoineeId, locationId]);
    if (row) return row.id;
  }
  return null;
}

// Headphone rows still free to draft at the joinee's location: available_qty
// must exceed the units reserved by other joinees' un-approved drafts. Same
// preferred-model-then-anything fallback as laptops.
async function pickHeadphone(t, patterns, excludeJoineeId, locationId) {
  if (!locationId) return null;
  for (const p of [...patterns, '']) {
    const row = await t.get(
      `SELECT a.id FROM accessories a
        JOIN asset_categories c ON a.category_id = c.id
       WHERE c.name = $1 AND a.deleted_at IS NULL AND a.location_id = $4
         AND (a.name ILIKE $2 OR a.model_number ILIKE $2)
         AND a.available_qty > (
           SELECT COUNT(*) FROM new_joinees nj
            WHERE nj.draft_headphone_accessory_id = a.id
              AND nj.allocation_status = 'draft' AND nj.id <> $3)
       ORDER BY a.id LIMIT 1`,
      [HEADPHONE_CATEGORY, `%${p}%`, excludeJoineeId, locationId]);
    if (row) return row.id;
  }
  return null;
}

// The agent: draft allocations for every joinee that doesn't have one yet.
// Runs on each New Joinees page load; drafts are idempotent and only touch
// rows still in 'pending', 'draft' rows missing an item (e.g. lost to a
// concurrent checkout), or drafts whose item sits at a different location
// than the joinee (self-heals after a location/policy change). Never
// finalizes anything.
async function ensureDrafts() {
  let drafted = 0;
  await db.tx(async t => {
    const todo = await t.query(
      `SELECT nj.id, nj.designation, nj.location_id FROM new_joinees nj
        WHERE nj.allocation_status = 'pending'
           OR (nj.allocation_status = 'draft'
               AND (nj.draft_laptop_asset_id IS NULL OR nj.draft_headphone_accessory_id IS NULL
                    OR EXISTS (SELECT 1 FROM assets a WHERE a.id = nj.draft_laptop_asset_id
                                 AND a.location_id IS DISTINCT FROM nj.location_id)
                    OR EXISTS (SELECT 1 FROM accessories ac WHERE ac.id = nj.draft_headphone_accessory_id
                                 AND ac.location_id IS DISTINCT FROM nj.location_id)))
        ORDER BY nj.id FOR UPDATE`);
    for (const j of todo) {
      const rule = ruleFor(j.designation);
      const laptopId = await pickLaptop(t, rule.laptops, j.id, j.location_id);
      const headphoneId = await pickHeadphone(t, rule.headphones, j.id, j.location_id);
      await t.run(
        `UPDATE new_joinees
            SET draft_laptop_asset_id = $1, draft_headphone_accessory_id = $2,
                draft_note = $3, draft_generated_at = CURRENT_TIMESTAMP,
                allocation_status = 'draft', updated_at = CURRENT_TIMESTAMP
          WHERE id = $4`,
        [laptopId, headphoneId, `Agent draft — ${rule.label}`, j.id]);
      drafted += 1;
    }
  });
  return drafted;
}

// Joinee list for the New Joinee section, with draft/final asset details.
async function listJoinees() {
  const rows = await db.query(
    `SELECT nj.*, nj.date_of_joining::text AS date_of_joining, l.name AS location_name,
            la.asset_tag AS laptop_tag, la.model_number AS laptop_model, la.status AS laptop_status,
            hp.name AS headphone_name, hp.model_number AS headphone_model,
            ab.name AS allocated_by_name
       FROM new_joinees nj
       LEFT JOIN locations l ON nj.location_id = l.id
       LEFT JOIN assets la ON nj.draft_laptop_asset_id = la.id
       LEFT JOIN accessories hp ON nj.draft_headphone_accessory_id = hp.id
       LEFT JOIN users ab ON nj.allocated_by = ab.id
      ORDER BY nj.allocation_status = 'allocated', nj.date_of_joining DESC, nj.id`);
  return rows.map(r => ({ ...r, rule: ruleFor(r.designation) }));
}

// Dropdown options for the engineer's edit modal. Each option carries its
// location_id — the modal shows only items at the joinee's location (and
// renders "Asset not available" when a location has none).
async function allocationOptions() {
  const laptops = await db.query(
    `SELECT a.id, a.asset_tag, a.model_number, a.location_id
       FROM assets a JOIN asset_categories c ON a.category_id = c.id
      WHERE c.name = $1 AND a.deleted_at IS NULL AND a.assigned_to IS NULL
        AND LOWER(a.status) = 'available'
      ORDER BY a.model_number, a.asset_tag`, [LAPTOP_CATEGORY]);
  const headphones = await db.query(
    `SELECT a.id, a.name, a.model_number, a.available_qty, a.location_id
       FROM accessories a JOIN asset_categories c ON a.category_id = c.id
      WHERE c.name = $1 AND a.deleted_at IS NULL AND a.available_qty > 0
      ORDER BY a.name, a.id`, [HEADPHONE_CATEGORY]);
  return {
    laptops: laptops.map(a => ({
      id: a.id, tag: a.asset_tag, model: a.model_number || 'Unknown model',
      locationId: a.location_id, premium: PREMIUM_PATTERN.test(a.model_number || '')
    })),
    headphones: headphones.map(a => ({
      id: a.id, name: a.name, model: a.model_number || '',
      locationId: a.location_id, available: a.available_qty
    }))
  };
}

// Engineer edits the agent's draft. Both picks are re-validated against live
// availability so a stale form can't draft an already-taken item.
async function updateDraft(id, data, actor) {
  id = intOr(id);
  const laptopId = intOr(data.laptop_asset_id, 0);
  const headphoneId = intOr(data.headphone_accessory_id, 0);
  const joinee = await db.get('SELECT * FROM new_joinees WHERE id = $1', [id]);
  if (!joinee) throw new HttpError('New joinee not found.', 404);
  if (joinee.allocation_status === 'allocated') {
    throw new HttpError('Allocation is already finalized for this joinee.', 422);
  }
  if (laptopId > 0 && laptopId !== joinee.draft_laptop_asset_id) {
    const ok = await db.get(
      `SELECT 1 FROM assets a JOIN asset_categories c ON a.category_id = c.id
        WHERE a.id = $1 AND c.name = $2 AND a.deleted_at IS NULL
          AND a.assigned_to IS NULL AND LOWER(a.status) = 'available'
          AND a.location_id = $3`,
      [laptopId, LAPTOP_CATEGORY, joinee.location_id]);
    if (!ok) throw new HttpError('Selected laptop is not available at the joinee\'s location.', 422);
  }
  if (headphoneId > 0 && headphoneId !== joinee.draft_headphone_accessory_id) {
    const ok = await db.get(
      `SELECT 1 FROM accessories a JOIN asset_categories c ON a.category_id = c.id
        WHERE a.id = $1 AND c.name = $2 AND a.deleted_at IS NULL AND a.available_qty > 0
          AND a.location_id = $3`,
      [headphoneId, HEADPHONE_CATEGORY, joinee.location_id]);
    if (!ok) throw new HttpError('Selected headphones are not available at the joinee\'s location.', 422);
  }
  await db.run(
    `UPDATE new_joinees
        SET draft_laptop_asset_id = $1, draft_headphone_accessory_id = $2,
            draft_note = $3, allocation_status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE id = $4`,
    [laptopId > 0 ? laptopId : null, headphoneId > 0 ? headphoneId : null,
      'Engineer-adjusted allocation', id]);
  await audit.log(actor ? actor.id : null, 'JOINEE_DRAFT_UPDATED',
    `Allocation draft updated for new joinee ${joinee.name} (${joinee.employee_id}).`);
  return true;
}

// Engineer approval: finalize via the existing checkout/assignment writers so
// every downstream tab (Assets, Accessories, ledger, audit) stays in sync.
// The laptop checkout re-validates availability inside its own transaction.
async function approveAllocation(id, actor) {
  id = intOr(id);
  const joinee = await db.get('SELECT * FROM new_joinees WHERE id = $1', [id]);
  if (!joinee) throw new HttpError('New joinee not found.', 404);
  if (joinee.allocation_status === 'allocated') {
    throw new HttpError('Allocation is already finalized for this joinee.', 422);
  }
  if (!joinee.draft_laptop_asset_id || !joinee.draft_headphone_accessory_id) {
    throw new HttpError('Draft is incomplete — pick both a laptop and a headphone before allocating.', 422);
  }
  const note = `New joinee onboarding — ${joinee.designation} (${joinee.employee_id})`;

  await assetService.checkoutAsset(joinee.draft_laptop_asset_id,
    { user_id: joinee.user_id, checkout_notes: note }, actor);
  try {
    await inventoryWorkflow.assign('accessories', joinee.draft_headphone_accessory_id,
      { user_id: joinee.user_id, quantity: 1, notes: note }, actor ? actor.id : null);
  } catch (err) {
    // Roll the laptop back so a headphone stock failure doesn't half-allocate.
    await assetService.checkinAsset(joinee.draft_laptop_asset_id,
      { checkin_notes: 'Rollback: headphone allocation failed' }, actor).catch(() => {});
    throw err;
  }

  await db.run(
    `UPDATE new_joinees
        SET allocation_status = 'allocated', allocated_at = CURRENT_TIMESTAMP,
            allocated_by = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`, [actor ? actor.id : null, id]);
  // Onboarding complete: activate the directory account.
  await db.run(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending'`,
    [joinee.user_id]);
  await audit.log(actor ? actor.id : null, 'JOINEE_ALLOCATED',
    `Onboarding assets allocated to ${joinee.name} (${joinee.employee_id}).`);
  return true;
}

module.exports = {
  ensureDrafts, listJoinees, allocationOptions, updateDraft, approveAllocation,
  ALLOCATION_RULES
};
