// Port of DepartmentService.
const db = require('../core/db');
const Paginator = require('../core/paginator');
const { nullableId, HttpError, trimStr } = require('../core/helpers');

async function count(filters = {}) {
  const params = [];
  let where = '1=1';
  if (filters.search) {
    where = '(name ILIKE $1 OR cost_center ILIKE $1)';
    params.push(`%${filters.search}%`);
  }
  const row = await db.get(`SELECT COUNT(*)::int AS c FROM departments WHERE ${where}`, params);
  return row.c;
}

async function list(page = 1, perPage = 15, filters = {}) {
  const offset = (page - 1) * perPage;
  const params = [];
  let where = '1=1';
  if (filters.search) {
    where = '(d.name ILIKE $1 OR d.cost_center ILIKE $1)';
    params.push(`%${filters.search}%`);
  }
  return db.query(
    `SELECT d.*, pd.name AS parent_name, u.name AS manager_name,
       (SELECT COUNT(*)::int FROM users us WHERE us.department_id = d.id) AS users_count
     FROM departments d
     LEFT JOIN departments pd ON d.parent_id = pd.id
     LEFT JOIN users u ON d.manager_id = u.id
     WHERE ${where} ORDER BY d.name ASC LIMIT ${perPage} OFFSET ${offset}`,
    params);
}

async function getMetadata() {
  const [managers, departments] = await Promise.all([
    db.query(`SELECT id, name FROM users WHERE role IN ('admin', 'manager') ORDER BY name`),
    db.query('SELECT id, name FROM departments ORDER BY name')
  ]);
  return { managers, departments };
}

async function create(data) {
  const name = trimStr(data.name);
  if (!name) throw new HttpError('Department name is required.', 422);
  return db.insert(
    'INSERT INTO departments (name, parent_id, manager_id, cost_center) VALUES ($1,$2,$3,$4)',
    [name, nullableId(data.parent_id), nullableId(data.manager_id), trimStr(data.cost_center) || null]);
}

async function update(id, data) {
  const name = trimStr(data.name);
  if (!name) throw new HttpError('Department name is required.', 422);
  if (nullableId(data.parent_id) === parseInt(id, 10)) {
    throw new HttpError('A department cannot be its own parent.', 422);
  }
  await db.run('UPDATE departments SET name=$1, parent_id=$2, manager_id=$3, cost_center=$4 WHERE id=$5',
    [name, nullableId(data.parent_id), nullableId(data.manager_id), trimStr(data.cost_center) || null, id]);
  return true;
}

async function remove(id) {
  const users = await db.get('SELECT COUNT(*)::int AS c FROM users WHERE department_id = $1', [id]);
  if (users.c > 0) throw new HttpError('Cannot delete department with active users.', 422);
  await db.run('DELETE FROM departments WHERE id = $1', [id]);
  return true;
}

module.exports = { count, list, getMetadata, create, update, remove };
