// Port of CustomFieldService
const db = require('../core/db');

async function getFieldsByModule(moduleKey, categoryId = null) {
  const rows = await db.query(
    `SELECT cf.*, cff.order_rank FROM custom_fieldsets fs
       JOIN custom_fieldset_module cfm ON cfm.fieldset_id = fs.id
       JOIN custom_fieldset_field cff ON cff.fieldset_id = fs.id
       JOIN custom_fields cf ON cf.id = cff.field_id
      WHERE cfm.module_key = $1 AND (cfm.category_id IS NULL OR cfm.category_id = $2)
      ORDER BY cfm.category_id DESC NULLS LAST, cff.order_rank ASC`,
    [moduleKey, categoryId]
  );
  const byKey = {};
  for (const row of rows) {
    if (!byKey[row.field_key]) byKey[row.field_key] = row;
  }
  return byKey;
}

async function getFieldsByFieldset(fieldsetId) {
  const rows = await db.query(
    `SELECT cf.*, cff.order_rank FROM custom_fields cf
       JOIN custom_fieldset_field cff ON cf.id = cff.field_id
      WHERE cff.fieldset_id = $1 ORDER BY cff.order_rank ASC`,
    [fieldsetId]
  );
  const byKey = {};
  for (const row of rows) byKey[row.field_key] = row;
  return byKey;
}

async function getFieldsByCategory(categoryId) {
  const fields = await getFieldsByModule('assets', categoryId || null);
  const cat = await db.get('SELECT fieldset_id FROM asset_categories WHERE id = $1', [categoryId || 0]);
  if (cat && cat.fieldset_id) {
    Object.assign(fields, await getFieldsByFieldset(cat.fieldset_id));
  }
  return Object.values(fields);
}

module.exports = { getFieldsByModule, getFieldsByFieldset, getFieldsByCategory };
