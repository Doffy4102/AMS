// Port of PermissionService: roles, permission matrix, user role assignment.
const db = require('../core/db');
const audit = require('./auditService');
const authz = require('./authorizationService');
const { nullableId, HttpError, trimStr, intOr } = require('../core/helpers');

async function getRoles() {
  return db.query(
    `SELECT r.*,
       (SELECT COUNT(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS users_count,
       (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS permissions_count
     FROM roles r ORDER BY r.level DESC, r.name ASC`);
}

async function getLocations() {
  return db.query('SELECT id, name, city, country FROM locations ORDER BY name ASC');
}

async function getRole(id) {
  const role = await db.get('SELECT * FROM roles WHERE id = $1', [id]);
  if (!role) return null;
  const perms = await db.query('SELECT permission_id FROM role_permissions WHERE role_id = $1', [id]);
  role.permissions = perms.map(p => parseInt(p.permission_id, 10));
  const scopes = await db.query('SELECT location_id FROM role_location_scopes WHERE role_id = $1', [id]);
  role.location_ids = scopes.map(s => parseInt(s.location_id, 10));
  return role;
}

async function getAllPermissions() {
  const rows = await db.query(
    `SELECT p.*, m.label AS module_label, m.icon AS module_icon, m.is_active AS module_active
     FROM permissions p LEFT JOIN modules m ON p.module_id = m.id
     ORDER BY (p.module_id IS NULL) DESC, m.id, p.action`);
  const grouped = {};
  for (const row of rows) {
    const key = row.module_label || 'System';
    grouped[key] = grouped[key] || [];
    grouped[key].push(row);
  }
  return grouped;
}

async function assertCanManageLevel(level, actor) {
  if (level >= 100 && !(await authz.isSuperAdmin(actor))) {
    throw new HttpError('Only super administrators can create or edit level 100 roles.', 403);
  }
}

function normalizeIds(list) {
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  return [...new Set(list.map(Number).filter(Boolean))];
}

async function syncRolePermissions(t, roleId, permissionIds) {
  await t.run('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
  for (const pid of normalizeIds(permissionIds)) {
    await t.run('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, pid]);
  }
}

async function syncRoleLocationScopes(t, roleId, locationIds) {
  await t.run('DELETE FROM role_location_scopes WHERE role_id = $1', [roleId]);
  for (const lid of normalizeIds(locationIds)) {
    await t.run('INSERT INTO role_location_scopes (role_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, lid]);
  }
}

async function createRole(data, actor) {
  const name = trimStr(data.name).toLowerCase();
  const displayName = trimStr(data.display_name);
  if (!name || !displayName) throw new HttpError('Role name and display name are required.', 422);
  const level = intOr(data.level, 0);
  await assertCanManageLevel(level, actor);
  const id = await db.tx(async t => {
    const roleId = await t.insert(
      'INSERT INTO roles (name, display_name, description, level) VALUES ($1,$2,$3,$4)',
      [name, displayName, trimStr(data.description), level]);
    await syncRolePermissions(t, roleId, data.permissions);
    await syncRoleLocationScopes(t, roleId, data.location_ids);
    return roleId;
  });
  await audit.log(actor ? actor.id : null, 'ROLE_CREATED', `Role ${displayName} (${name}) created.`);
  return id;
}

async function updateRole(id, data, actor) {
  const role = await db.get('SELECT * FROM roles WHERE id = $1', [id]);
  if (!role) throw new HttpError('Role not found.', 404);
  const name = trimStr(data.name).toLowerCase();
  const displayName = trimStr(data.display_name);
  if (!name || !displayName) throw new HttpError('Role name and display name are required.', 422);
  const level = intOr(data.level, 0);
  await assertCanManageLevel(level, actor);
  if (role.name === 'super_admin' && (name !== 'super_admin' || level < 100)) {
    throw new HttpError('The super administrator role name and level cannot be downgraded.', 422);
  }
  await db.tx(async t => {
    await t.run('UPDATE roles SET name=$1, display_name=$2, description=$3, level=$4 WHERE id=$5',
      [name, displayName, trimStr(data.description), level, id]);
    await syncRolePermissions(t, id, data.permissions);
    await syncRoleLocationScopes(t, id, data.location_ids);
  });
  await audit.log(actor ? actor.id : null, 'ROLE_UPDATED', `Role ${displayName} (${name}) updated.`);
  return true;
}

async function deleteRole(id, actor) {
  const role = await db.get('SELECT * FROM roles WHERE id = $1', [id]);
  if (!role) throw new HttpError('Role not found.', 404);
  if (role.name === 'super_admin') throw new HttpError('The super administrator role cannot be deleted.', 422);
  const assigned = await db.get('SELECT COUNT(*)::int AS c FROM user_roles WHERE role_id = $1', [id]);
  if (assigned.c > 0) throw new HttpError('Cannot delete role with assigned users.', 422);
  await db.run('DELETE FROM roles WHERE id = $1', [id]);
  await audit.log(actor ? actor.id : null, 'ROLE_DELETED', `Role ${role.display_name || role.name} deleted.`);
  return true;
}

async function createPermission(data, actor) {
  const action = trimStr(data.action).toLowerCase();
  if (!action) throw new HttpError('Action is required for permissions.', 422);
  const moduleId = nullableId(data.module_id);
  let moduleName = 'system';
  if (moduleId) {
    const mod = await db.get('SELECT name FROM modules WHERE id = $1', [moduleId]);
    moduleName = mod ? mod.name : 'system';
  }
  const name = trimStr(data.name) || `${moduleName}.${action}`;
  const id = await db.insert(
    'INSERT INTO permissions (module_id, module, action, name) VALUES ($1,$2,$3,$4)',
    [moduleId, moduleName, action, name]);
  await audit.log(actor ? actor.id : null, 'PERMISSION_CREATED', `Permission ${name} created.`);
  return id;
}

async function updateUserRole(userId, roleId, actor) {
  await db.tx(async t => {
    const role = await t.get('SELECT * FROM roles WHERE id = $1', [roleId]);
    if (!role) throw new HttpError('Role not found.', 404);
    if (role.name === 'super_admin' && !(await authz.isSuperAdmin(actor))) {
      throw new HttpError('Only super administrators can assign the super administrator role.', 403);
    }
    const target = await t.get('SELECT * FROM users WHERE id = $1', [userId]);
    if (role.name !== 'super_admin' && target && target.role === 'super_admin') {
      const count = await t.get(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'super_admin' AND deleted_at IS NULL`);
      if (count.c <= 1) throw new HttpError('Cannot remove the last super administrator.', 422);
    }
    await t.run('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await t.run('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId]);
    await t.run('UPDATE users SET role = $1 WHERE id = $2', [role.name, userId]);
    await audit.log(actor ? actor.id : null, 'USER_ROLE_UPDATED', `User #${userId} assigned role ${role.name}.`);
  });
  return true;
}

module.exports = {
  getRoles, getLocations, getRole, getAllPermissions,
  createRole, updateRole, deleteRole, createPermission, updateUserRole
};
