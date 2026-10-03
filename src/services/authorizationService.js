// Port of AuthorizationService: RBAC resolution with super-admin bypass,
// wildcard + manage grants, implicit view, and location scoping.
const db = require('../core/db');
const { HttpError } = require('../core/helpers');

async function isSuperAdmin(user) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (['super_admin', 'superadmin', 'admin'].includes(role)) return true;
  const row = await db.get(
    `SELECT COUNT(*)::int AS c FROM user_roles ur JOIN roles r ON ur.role_id = r.id
     WHERE ur.user_id = $1 AND r.level >= 100`,
    [user.id]
  );
  return row && row.c > 0;
}

async function permissionsFor(user) {
  if (!user) return [];
  const rows = await db.query(
    `SELECT DISTINCT p.name FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       JOIN user_roles ur ON rp.role_id = ur.role_id
       LEFT JOIN modules m ON p.module_id = m.id
      WHERE ur.user_id = $1 AND (p.module_id IS NULL OR m.is_active = TRUE)
     UNION
     SELECT DISTINCT p.name FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       JOIN roles r ON rp.role_id = r.id
       LEFT JOIN modules m ON p.module_id = m.id
      WHERE r.name = $2 AND (p.module_id IS NULL OR m.is_active = TRUE)`,
    [user.id, user.role || '']
  );
  return [...new Set(rows.map(r => r.name))];
}

async function can(permission, user) {
  if (!user) return false;
  if (await isSuperAdmin(user)) return true;
  const perms = await permissionsFor(user);
  if (perms.includes('*')) return true;
  if (perms.includes(permission)) return true;
  const dot = permission.indexOf('.');
  if (dot > 0) {
    const module = permission.slice(0, dot);
    const action = permission.slice(dot + 1);
    if (perms.includes(module + '.*') || perms.includes(module + '.manage')) return true;
    if (action === 'view') {
      if (['create', 'edit', 'delete'].some(a => perms.includes(module + '.' + a))) return true;
    }
  }
  return false;
}

async function requirePermission(permission, user) {
  if (!(await can(permission, user))) {
    throw new HttpError('You do not have permission to access this area.', 403);
  }
}

async function locationScopeFor(user) {
  if (!user) return { global: false, location_ids: [] };
  if (await isSuperAdmin(user)) return { global: true, location_ids: [] };
  let rows = await db.query(
    `SELECT DISTINCT rls.location_id FROM role_location_scopes rls
       JOIN user_roles ur ON ur.role_id = rls.role_id
      WHERE ur.user_id = $1`,
    [user.id]
  );
  if (rows.length === 0 && user.role) {
    rows = await db.query(
      `SELECT DISTINCT rls.location_id FROM role_location_scopes rls
         JOIN roles r ON r.id = rls.role_id
        WHERE r.name = $1`,
      [user.role]
    );
  }
  const ids = rows.map(r => parseInt(r.location_id, 10));
  return { global: ids.length === 0, location_ids: ids };
}

async function canAccessLocation(locationId, user) {
  if (locationId === null || locationId === undefined || locationId === '') return true;
  const scope = await locationScopeFor(user);
  return scope.global || scope.location_ids.includes(parseInt(locationId, 10));
}

async function applyLocationScope(filters, user) {
  const scope = await locationScopeFor(user);
  if (scope.global) return filters;
  const out = { ...filters };
  if (out.location_id) {
    if (!scope.location_ids.includes(parseInt(out.location_id, 10))) out.location_id = -1;
  } else {
    out.location_ids = scope.location_ids;
  }
  return out;
}

module.exports = {
  isSuperAdmin, permissionsFor, can, requirePermission,
  locationScopeFor, canAccessLocation, applyLocationScope
};
