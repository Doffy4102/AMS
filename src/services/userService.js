// Port of UserService + UserRepository.
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const audit = require('./auditService');
const authz = require('./authorizationService');
const { nullableId, HttpError, trimStr } = require('../core/helpers');

async function syncUserRole(t, userId, roleName) {
  const role = await t.get('SELECT id FROM roles WHERE name = $1 LIMIT 1', [roleName]);
  if (!role) return;
  await t.run('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  await t.run('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, role.id]);
}

async function getDirectory(user) {
  const rows = await db.query(
    `SELECT u.*, d.name AS department_name, l.name AS location_name, r.display_name AS role_display_name
     FROM users u
     LEFT JOIN departments d ON u.department_id = d.id
     LEFT JOIN locations l ON u.location_id = l.id
     LEFT JOIN roles r ON u.role = r.name
     WHERE u.deleted_at IS NULL ORDER BY u.created_at DESC`);
  const scope = await authz.locationScopeFor(user);
  if (scope.global) return rows;
  return rows.filter(u => !u.location_id || scope.location_ids.includes(parseInt(u.location_id, 10)));
}

async function getReferenceData(user) {
  const [departments, locationsAll, roles] = await Promise.all([
    db.query('SELECT id, name FROM departments ORDER BY name ASC'),
    db.query('SELECT id, name FROM locations ORDER BY name ASC'),
    db.query('SELECT id, name, display_name FROM roles ORDER BY level DESC')
  ]);
  const scope = await authz.locationScopeFor(user);
  const locations = scope.global ? locationsAll
    : locationsAll.filter(l => scope.location_ids.includes(parseInt(l.id, 10)));
  return { departments, locations, roles };
}

async function findByEmail(email) {
  return db.get('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
}

async function findById(id) {
  return db.get(
    `SELECT u.*, d.name AS department_name, l.name AS location_name FROM users u
     LEFT JOIN departments d ON u.department_id = d.id
     LEFT JOIN locations l ON u.location_id = l.id
     WHERE u.id = $1 AND u.deleted_at IS NULL`, [id]);
}

async function getAssignedAssets(userId) {
  return db.query(
    `SELECT a.*, ac.name AS category_name, sl.name AS status_label_name FROM assets a
     LEFT JOIN asset_categories ac ON a.category_id = ac.id
     LEFT JOIN status_labels sl ON a.status_label_id = sl.id
     WHERE a.assigned_to = $1 ORDER BY a.name ASC`, [userId]);
}

async function getUserDetails(id, actor) {
  const user = await findById(id);
  if (!user) return null;
  if (!(await authz.canAccessLocation(user.location_id, actor))) return null;
  user.roles = await db.query(
    `SELECT r.* FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`, [id]);
  user.assets = await getAssignedAssets(id);
  return user;
}

async function createUser(data, actor) {
  const name = trimStr(data.name);
  const email = trimStr(data.email);
  const employeeId = trimStr(data.employee_id);
  const role = data.role || 'employee';
  const status = data.status || 'active';
  const locationId = nullableId(data.location_id);

  if (!name || !email || !data.password) throw new HttpError('Name, email, and password are required.', 422);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError('Please enter a valid email address.', 422);
  if (String(data.password).length < 8) throw new HttpError('Password must be at least 8 characters.', 422);
  if (!(await authz.canAccessLocation(locationId, actor))) {
    throw new HttpError('You do not have access to create users in this location.', 403);
  }
  if (await findByEmail(email)) throw new HttpError('A user with this email already exists.', 422);

  const password = await bcrypt.hash(String(data.password), 10);
  const userId = await db.tx(async t => {
    const id = await t.insert(
      'INSERT INTO users (name, email, password, role, status, employee_id, department_id, location_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [name, email, password, role, status, employeeId || null, nullableId(data.department_id), locationId]);
    await syncUserRole(t, id, role);
    return id;
  });
  await audit.log(actor ? actor.id : null, 'USER_CREATED', `User ${name} (${email}) created with role: ${role}.`);
  return userId;
}

async function updateUser(id, data, actor) {
  const name = trimStr(data.name);
  const email = trimStr(data.email);
  const employeeId = trimStr(data.employee_id);
  const role = data.role || 'employee';
  const status = data.status || 'active';
  const locationId = nullableId(data.location_id);

  if (!name || !email) throw new HttpError('Name and email are required.', 422);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError('Please enter a valid email address.', 422);
  if (data.password && String(data.password).length < 8) throw new HttpError('Password must be at least 8 characters.', 422);

  const user = await findById(id);
  if (!user) throw new HttpError('User not found.', 404);
  if (!(await authz.canAccessLocation(user.location_id, actor)) || !(await authz.canAccessLocation(locationId, actor))) {
    throw new HttpError('You do not have permission to modify users in this location.', 403);
  }

  await db.tx(async t => {
    const sets = ['name = $1', 'email = $2', 'role = $3', 'status = $4', 'employee_id = $5',
      'department_id = $6', 'location_id = $7', 'updated_at = CURRENT_TIMESTAMP'];
    const vals = [name, email, role, status, employeeId || null, nullableId(data.department_id), locationId];
    let i = 8;
    if (data.password) {
      sets.push(`password = $${i++}`);
      vals.push(await bcrypt.hash(String(data.password), 10));
    }
    if (data.two_factor_enabled !== undefined && data.two_factor_enabled !== null) {
      sets.push(`two_factor_enabled = $${i++}`);
      vals.push(data.two_factor_enabled === '1' || data.two_factor_enabled === 1 || data.two_factor_enabled === true);
    }
    if (data.reset_two_factor) {
      sets.push('two_factor_secret = NULL', 'two_factor_enabled = FALSE');
    }
    vals.push(id);
    await t.run(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    await syncUserRole(t, id, role);
  });
  await audit.log(actor ? actor.id : null, 'USER_UPDATED', `User ${user.name} (ID: ${id}) updated.`);
  return true;
}

module.exports = {
  getDirectory, getReferenceData, findByEmail, findById, getUserDetails,
  getAssignedAssets, createUser, updateUser, syncUserRole
};
