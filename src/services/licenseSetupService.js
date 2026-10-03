// Port of LicenseSetupService: license_manufacturers / license_suppliers.
const db = require('../core/db');
const audit = require('./auditService');
const { HttpError, trimStr } = require('../core/helpers');

const TABLES = { manufacturers: 'license_manufacturers', suppliers: 'license_suppliers' };

function tableFor(type) {
  const table = TABLES[type];
  if (!table) throw new HttpError('Unknown license setup type.', 400);
  return table;
}

async function page() {
  const [manufacturers, suppliers] = await Promise.all([
    db.query('SELECT * FROM license_manufacturers WHERE deleted_at IS NULL ORDER BY name ASC'),
    db.query('SELECT * FROM license_suppliers WHERE deleted_at IS NULL ORDER BY name ASC')
  ]);
  return { manufacturers, suppliers };
}

async function create(type, data, user) {
  const table = tableFor(type);
  const name = trimStr(data.name);
  if (!name) throw new HttpError('Name is required.', 422);
  let id;
  if (type === 'suppliers') {
    id = await db.insert(
      'INSERT INTO license_suppliers (name, contact_name, email, phone, website, notes) VALUES ($1,$2,$3,$4,$5,$6)',
      [name, trimStr(data.contact_name), trimStr(data.email), trimStr(data.phone), trimStr(data.website), trimStr(data.notes)]);
  } else {
    id = await db.insert(
      'INSERT INTO license_manufacturers (name, website, support_url, notes) VALUES ($1,$2,$3,$4)',
      [name, trimStr(data.website), trimStr(data.support_url), trimStr(data.notes)]);
  }
  await audit.log(user ? user.id : null, 'LICENSE_SETUP_CREATED', `Created license ${type}: ${name}.`);
  return id;
}

async function update(type, id, data, user) {
  const table = tableFor(type);
  const name = trimStr(data.name);
  if (!name) throw new HttpError('Name is required.', 422);
  if (type === 'suppliers') {
    await db.run('UPDATE license_suppliers SET name=$1, contact_name=$2, email=$3, phone=$4, website=$5, notes=$6 WHERE id=$7',
      [name, trimStr(data.contact_name), trimStr(data.email), trimStr(data.phone), trimStr(data.website), trimStr(data.notes), id]);
  } else {
    await db.run('UPDATE license_manufacturers SET name=$1, website=$2, support_url=$3, notes=$4 WHERE id=$5',
      [name, trimStr(data.website), trimStr(data.support_url), trimStr(data.notes), id]);
  }
  await audit.log(user ? user.id : null, 'LICENSE_SETUP_UPDATED', `Updated license ${type} #${id}.`);
  return true;
}

async function remove(type, id, user) {
  const table = tableFor(type);
  await db.run(`UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  await audit.log(user ? user.id : null, 'LICENSE_SETUP_DELETED', `Deleted license ${type} #${id}.`);
  return true;
}

module.exports = { page, create, update, remove };
