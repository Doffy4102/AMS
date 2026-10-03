// Users, Roles/Permissions, Modules, Settings, Backups, API Tokens, Logs, Automations.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../core/db');
const config = require('../config');
const userService = require('../services/userService');
const permissionService = require('../services/permissionService');
const moduleService = require('../services/moduleService');
const settingsService = require('../services/settingsService');
const backupService = require('../services/backupService');
const apiTokenService = require('../services/apiTokenService');
const automationService = require('../services/automationService');
const logService = require('../services/logService');
const auditService = require('../services/auditService');
const authz = require('../services/authorizationService');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { hamsUrl, sanitizeBody, intOr, trimStr } = require('../core/helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Users ───
router.get('/users', authRequired, perm('personnel.view'), mod('personnel'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('users/index', {
      users: await userService.getDirectory(user),
      references: await userService.getReferenceData(user),
      active_tab: 'users'
    });
  } catch (err) { next(err); }
});

router.post('/users', authRequired, csrfProtect, perm('personnel.create'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await userService.createUser(sanitizeBody(req.body), actor);
      req.flash('success', 'User created successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/users'));
  } catch (err) { next(err); }
});

router.get('/users/ldap', authRequired, perm('personnel.view'), mod('personnel'), async (req, res, next) => {
  try {
    const filters = { search: req.query.search || '', status: req.query.status || '' };
    const where = [];
    const params = [];
    let i = 1;
    if (filters.search) {
      where.push(`(ldu.display_name ILIKE $${i} OR ldu.email ILIKE $${i} OR ldu.username ILIKE $${i} OR ldu.department ILIKE $${i})`);
      params.push(`%${filters.search}%`);
      i += 1;
    }
    if (filters.status) { where.push(`ldu.sync_status = $${i++}`); params.push(filters.status); }
    const users = await db.query(
      `SELECT ldu.*, u.name AS local_user_name, u.status AS local_user_status
       FROM ldap_directory_users ldu LEFT JOIN users u ON u.id = ldu.local_user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ldu.last_seen_at DESC, ldu.display_name ASC`, params);
    const jobs = await db.query('SELECT * FROM ldap_sync_jobs ORDER BY started_at DESC LIMIT 20');
    const actor = await currentUser(req);
    res.renderPage('users/ldap-directory', {
      users, jobs, filters,
      settings: await settingsService.getByGroup('identity'),
      roles: (await userService.getReferenceData(actor)).roles,
      active_tab: 'ldap_users'
    });
  } catch (err) { next(err); }
});

router.post('/users/ldap/sync', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res) => {
  const enabled = (await settingsService.get('identity', 'ldap_enabled')) === '1';
  req.flash('error', enabled
    ? 'LDAP sync requires a reachable directory server; connection failed.'
    : 'LDAP integration is disabled. Enable it under Settings > Identity first.');
  res.redirect(hamsUrl('/users/ldap'));
});

router.post('/users/ldap/:id/update', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const canLogin = req.body.can_login === '1';
    const roleName = trimStr(req.body.role_name) || 'employee';
    const row = await db.get('SELECT * FROM ldap_directory_users WHERE id = $1', [intOr(req.params.id)]);
    if (row) {
      await db.run('UPDATE ldap_directory_users SET can_login = $1, role_name = $2 WHERE id = $3',
        [canLogin, roleName, row.id]);
      if (row.local_user_id) {
        await db.run('UPDATE users SET ldap_can_login = $1, role = $2 WHERE id = $3',
          [canLogin, roleName, row.local_user_id]);
      }
    }
    req.flash('success', 'LDAP user access updated.');
    res.redirect(hamsUrl('/users/ldap'));
  } catch (err) { next(err); }
});

router.get('/users/departments', authRequired, (req, res) => res.redirect(hamsUrl('/inventory-setup/departments')));

router.get('/users/:id', authRequired, perm('personnel.view'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const user = await userService.getUserDetails(intOr(req.params.id), actor);
    if (!user) return res.renderPage('_error', { message: 'User not found', statusCode: 404 });
    res.renderPage('users/show', { user, references: await userService.getReferenceData(actor) });
  } catch (err) { next(err); }
});

router.get('/users/:id/edit', authRequired, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const user = await userService.getUserDetails(intOr(req.params.id), actor);
    if (!user) return res.renderPage('_error', { message: 'User not found', statusCode: 404 });
    res.renderPage('users/edit', { user, references: await userService.getReferenceData(actor) });
  } catch (err) { next(err); }
});

router.post('/users/:id/update', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      await userService.updateUser(id, sanitizeBody(req.body), actor);
      req.flash('success', 'User updated successfully.');
      return res.redirect(hamsUrl('/users/' + id));
    } catch (err) {
      req.flash('error', err.message);
      res.redirect(hamsUrl('/users/' + id + '/edit'));
    }
  } catch (err) { next(err); }
});

router.post('/users/:id/role', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      await permissionService.updateUserRole(id, intOr(req.body.role_id), actor);
      req.flash('success', 'User role updated successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/users/' + id));
  } catch (err) { next(err); }
});

// ─── Roles & Permissions ───
router.get('/settings/roles', authRequired, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    res.renderPage('settings/roles', {
      roles: await permissionService.getRoles(),
      modules: await moduleService.getModules(),
      locations: await permissionService.getLocations(),
      active_tab: 'roles'
    });
  } catch (err) { next(err); }
});

router.post('/settings/roles', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await permissionService.createRole(req.body, actor);
      req.flash('success', 'Role created successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/roles'));
  } catch (err) { next(err); }
});

router.post('/settings/permissions', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await permissionService.createPermission(sanitizeBody(req.body), actor);
      req.flash('success', 'Permission created successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/roles'));
  } catch (err) { next(err); }
});

router.get('/settings/roles/:id', authRequired, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const role = await permissionService.getRole(intOr(req.params.id));
    if (!role) return res.renderPage('_error', { message: 'Role not found', statusCode: 404 });
    res.renderPage('settings/role-detail', {
      role,
      permissions: await permissionService.getAllPermissions(),
      locations: await permissionService.getLocations(),
      active_tab: 'roles'
    });
  } catch (err) { next(err); }
});

router.post('/settings/roles/:id/update', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await permissionService.updateRole(intOr(req.params.id), req.body, actor);
      req.flash('success', 'Role updated successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/roles'));
  } catch (err) { next(err); }
});

router.post('/settings/roles/:id/delete', authRequired, csrfProtect, perm('personnel.manage'), mod('personnel'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await permissionService.deleteRole(intOr(req.params.id), actor);
      req.flash('success', 'Role deleted successfully.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/roles'));
  } catch (err) { next(err); }
});

// ─── Modules ───
router.get('/settings/modules', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    res.renderPage('settings/modules', { modules: await moduleService.getModules(), active_tab: 'modules' });
  } catch (err) { next(err); }
});

router.post('/settings/modules/:id/toggle', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      const modRow = await moduleService.toggleModule(intOr(req.params.id));
      await auditService.log(actor.id, 'MODULE_TOGGLED', `Module toggled: ${modRow.name || req.params.id}`);
      req.flash('success', 'Module status updated successfully.');
    } catch (err) {
      req.flash('error', err.message === 'Core access modules cannot be disabled.' ? err.message : 'Failed to update module status.');
    }
    res.redirect(hamsUrl('/settings/modules'));
  } catch (err) { next(err); }
});

// ─── Backups ───
router.get('/settings/backups', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const data = await backupService.dashboard();
    res.renderPage('settings/backups', {
      ...data,
      backup_settings: await settingsService.getByGroup('backup'),
      active_tab: 'backups'
    });
  } catch (err) { next(err); }
});

router.post('/settings/backups', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await backupService.createBackup(req.body.backup_type || 'database', sanitizeBody(req.body), actor.id);
      req.flash('success', 'Backup created successfully.');
    } catch (err) { req.flash('error', 'Backup failed: ' + err.message); }
    res.redirect(hamsUrl('/settings/backups'));
  } catch (err) { next(err); }
});

router.post('/settings/backups/restore-upload', authRequired, upload.single('restore_file'), csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      if (!req.file) throw new Error('Please select a restore file.');
      const sql = req.file.buffer.toString('utf8');
      backupService.validateRestoreSql(sql);
      await db.run(sql);
      await auditService.log(actor.id, 'DATABASE_RESTORED', 'Database restored from uploaded backup.');
      req.flash('success', 'Database restored from uploaded backup.');
    } catch (err) { req.flash('error', 'Restore failed: ' + err.message); }
    res.redirect(hamsUrl('/settings/backups'));
  } catch (err) { next(err); }
});

router.post('/settings/backups/schedules', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await backupService.saveSchedule(sanitizeBody(req.body), actor.id);
      req.flash('success', 'Backup schedule saved.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/backups'));
  } catch (err) { next(err); }
});

router.post('/settings/backups/schedules/:id/toggle', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    await backupService.toggleSchedule(intOr(req.params.id), actor.id);
    req.flash('success', 'Backup schedule updated.');
    res.redirect(hamsUrl('/settings/backups'));
  } catch (err) { next(err); }
});

router.post('/settings/backups/run-due', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const count = await backupService.runDueSchedules(actor.id);
    req.flash('success', `Scheduled backups executed: ${count}`);
    res.redirect(hamsUrl('/settings/backups'));
  } catch (err) { next(err); }
});

router.get('/settings/backups/:id/download', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const job = await backupService.getJob(intOr(req.params.id));
    if (!job || job.status !== 'success' || !job.file_path || !fs.existsSync(job.file_path)) {
      req.flash('error', 'Backup file not found.');
      return res.redirect(hamsUrl('/settings/backups'));
    }
    res.download(job.file_path, path.basename(job.file_name || job.file_path));
  } catch (err) { next(err); }
});

router.post('/settings/backups/:id/restore', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await backupService.restoreDatabaseFromJob(intOr(req.params.id), actor.id);
      req.flash('success', 'Database restored from selected backup.');
    } catch (err) { req.flash('error', 'Restore failed: ' + err.message); }
    res.redirect(hamsUrl('/settings/backups'));
  } catch (err) { next(err); }
});

router.post('/settings/backups/:id/delete', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    try {
      await backupService.deleteJob(intOr(req.params.id));
      req.flash('success', 'Backup deleted.');
    } catch (err) { req.flash('error', 'Delete failed: ' + err.message); }
    res.redirect(hamsUrl('/settings/backups'));
  } catch (err) { next(err); }
});

// ─── Automations ───
router.get('/settings/automations', authRequired, perm('settings.manage'), async (req, res, next) => {
  try {
    res.renderPage('automations/index', { rules: await automationService.getAllRules(), active_tab: 'automations' });
  } catch (err) { next(err); }
});

router.post('/settings/automations', authRequired, csrfProtect, perm('settings.manage'), async (req, res, next) => {
  try {
    try {
      const body = req.body;
      const toArray = v => (v === undefined ? [] : (Array.isArray(v) ? v : [v]));
      const fields = toArray(body.condition_field);
      const operators = toArray(body.condition_operator);
      const values = toArray(body.condition_value);
      const conditions = fields
        .map((f, i) => ({ field: f, operator: operators[i] || '=', value: values[i] || '' }))
        .filter(c => c.field);
      const types = toArray(body.action_type);
      const actions = types.map((type, i) => {
        if (type === 'email') return { type, config: { to: toArray(body.action_config_to)[i] || '', subject: toArray(body.action_config_subject)[i] || 'HAMS Automation' } };
        if (type === 'webhook') return { type, config: { url: toArray(body.action_config_url)[i] || '' } };
        return { type: 'log', config: { message: toArray(body.action_config_msg)[i] || '' } };
      });
      await automationService.createRule({
        name: body.name || 'New Rule',
        event_trigger: body.event_trigger || '',
        conditions, actions,
        is_active: body.is_active !== undefined
      });
      req.flash('success', 'Automation rule created successfully.');
    } catch (err) { req.flash('error', 'Failed to create rule: ' + err.message); }
    res.redirect(hamsUrl('/settings/automations'));
  } catch (err) { next(err); }
});

router.post('/settings/automations/:id/delete', authRequired, csrfProtect, perm('settings.manage'), async (req, res, next) => {
  try {
    await automationService.deleteRule(intOr(req.params.id));
    req.flash('success', 'Automation rule deleted.');
    res.redirect(hamsUrl('/settings/automations'));
  } catch (err) { next(err); }
});

// ─── Settings pages ───
const SETTINGS_GROUPS = ['branding', 'organization', 'security', 'identity', 'notifications', 'monitoring'];

router.get('/settings', authRequired, perm('settings.manage'), mod('settings'),
  (req, res) => res.redirect(hamsUrl('/settings/branding')));

const ALLOWED_SETTINGS = {
  branding: ['app_name', 'app_tagline', 'app_logo', 'primary_color', 'sidebar_theme'],
  organization: ['timezone', 'currency', 'asset_prefix', 'default_warranty'],
  security: ['two_factor_system_enabled', 'mfa_required', 'session_timeout', 'pwd_min_length', 'pwd_special'],
  identity: ['ldap_enabled', 'ldap_host', 'ldap_port', 'ldap_base_dn', 'ldap_bind_dn', 'ldap_bind_password', 'ldap_tls',
    'ldap_user_filter', 'ldap_email_attribute', 'ldap_name_attribute', 'ldap_auto_provision', 'ldap_login_enabled',
    'ldap_default_role', 'ldap_sync_filter', 'ldap_sync_unique_attribute', 'ldap_sync_username_attribute',
    'ldap_sync_department_attribute', 'ldap_sync_title_attribute', 'ldap_sync_phone_attribute',
    'ldap_sync_incremental_attribute', 'ldap_sync_schedule_enabled', 'ldap_sync_frequency', 'ldap_sync_time',
    'saml_enabled', 'saml_sso_url', 'saml_entity_id', 'saml_acs_url', 'saml_certificate', 'saml_auto_provision',
    'oidc_enabled', 'oidc_client_id', 'oidc_client_secret', 'oidc_authorization_url', 'oidc_token_url',
    'oidc_userinfo_url', 'oidc_redirect_uri', 'oidc_scopes', 'oidc_auto_provision'],
  notifications: ['email_enabled', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_encryption',
    'mail_from', 'backup_failure_email', 'webhook_enabled', 'webhook_url'],
  monitoring: ['audit_retention_days', 'health_alerts_enabled'],
  backup: ['auto_backup_enabled', 'backup_retention_count']
};

const BOOLEAN_KEYS = {
  security: ['two_factor_system_enabled', 'mfa_required', 'pwd_special'],
  identity: ['ldap_enabled', 'ldap_tls', 'ldap_auto_provision', 'ldap_login_enabled', 'ldap_sync_schedule_enabled',
    'saml_enabled', 'saml_auto_provision', 'oidc_enabled', 'oidc_auto_provision'],
  notifications: ['email_enabled', 'backup_failure_email', 'webhook_enabled'],
  monitoring: ['health_alerts_enabled'],
  backup: ['auto_backup_enabled']
};

for (const group of SETTINGS_GROUPS) {
  router.get('/settings/' + group, authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
    try {
      const params = { settings: await settingsService.getByGroup(group), active_tab: group };
      if (group === 'identity') {
        params.roles = await db.query('SELECT name, display_name FROM roles ORDER BY level DESC, name ASC');
      }
      if (group === 'monitoring') {
        const dbOk = await db.get('SELECT 1 AS ok').then(() => true).catch(() => false);
        const backups = await db.get(`SELECT COUNT(*)::int AS c FROM backup_jobs WHERE status = 'success'`);
        params.snapshot = {
          db: { status: dbOk ? 'OPTIMAL' : 'ERROR' },
          backups: { status: backups.c > 0 ? 'READY' : 'PENDING', count: backups.c },
          logs: await db.query('SELECT l.*, u.name AS user_name FROM activity_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC LIMIT 10'),
          ldap: { ok: false, message: 'LDAP is not configured.' }
        };
      }
      res.renderPage('settings/' + group, params);
    } catch (err) { next(err); }
  });
}

router.post('/settings/update', authRequired, upload.single('app_logo'), csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    const group = req.body.group || 'branding';
    try {
      const allowed = ALLOWED_SETTINGS[group];
      if (!allowed) throw new Error('Invalid settings group');
      const data = { ...req.body };
      delete data.group;
      delete data._csrf;
      // Logo upload (branding only)
      if (group === 'branding' && req.file) {
        if (req.file.size > 2 * 1024 * 1024) throw new Error('Logo file must be 2 MB or smaller.');
        const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
        if (!['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext)) throw new Error('Logo must be a PNG, JPG, WEBP, or SVG file.');
        const dir = path.join(config.publicDir, 'uploads', 'branding');
        fs.mkdirSync(dir, { recursive: true });
        const fname = `logo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.${ext}`;
        fs.writeFileSync(path.join(dir, fname), req.file.buffer);
        data.app_logo = '/uploads/branding/' + fname;
      }
      const boolKeys = BOOLEAN_KEYS[group] || [];
      for (const key of boolKeys) {
        data[key] = data[key] !== undefined && String(data[key]) === '1' ? '1' : '0';
      }
      for (const [key, value] of Object.entries(data)) {
        if (allowed.includes(key)) await settingsService.set(group, key, value, actor.id);
      }
      req.flash('success', 'Enterprise settings updated successfully');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/' + group));
  } catch (err) { next(err); }
});

router.post('/settings/identity/test-ldap', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res) => {
  const enabled = (await settingsService.get('identity', 'ldap_enabled')) === '1';
  const host = await settingsService.get('identity', 'ldap_host', '');
  req.flash('error', !enabled ? 'LDAP is disabled.' : (!host ? 'LDAP host is not configured.' : 'LDAP connection could not be established from this server.'));
  res.redirect(hamsUrl('/settings/identity'));
});

// ─── API Tokens (super admin only, mirrors original hard check) ───
async function requireSuperAdmin(req, res) {
  const user = await currentUser(req);
  if (!(await authz.isSuperAdmin(user))) {
    req.flash('error', 'Only Super Administrators can manage API tokens.');
    res.redirect(hamsUrl('/'));
    return null;
  }
  return user;
}

router.get('/settings/api-tokens', authRequired, perm('api_tokens.view'), async (req, res, next) => {
  try {
    const user = await requireSuperAdmin(req, res);
    if (!user) return;
    const allPermissions = await db.query('SELECT id, module, action, name, module_id FROM permissions ORDER BY module, action');
    res.renderPage('settings/api-tokens', {
      tokens: await apiTokenService.listForUser(user.id),
      allPermissions,
      active_tab: 'api_tokens'
    });
  } catch (err) { next(err); }
});

router.post('/settings/api-tokens', authRequired, csrfProtect, perm('api_tokens.create'), async (req, res, next) => {
  try {
    const user = await requireSuperAdmin(req, res);
    if (!user) return;
    const name = trimStr(req.body.name);
    if (!name) {
      req.flash('error', 'Token name is required.');
      return res.redirect(hamsUrl('/settings/api-tokens'));
    }
    let abilities = req.body.abilities || [];
    if (!Array.isArray(abilities)) abilities = [abilities];
    const result = await apiTokenService.createForUser(user.id, name, abilities, apiTokenService.expiryFor(req.body.expires_in));
    req.flash('success', 'API token created successfully.');
    req.flash('new_token', result.raw_token);
    req.flash('new_token_name', name);
    res.redirect(hamsUrl('/settings/api-tokens'));
  } catch (err) { next(err); }
});

router.post('/settings/api-tokens/:id/revoke', authRequired, csrfProtect, perm('api_tokens.revoke'), async (req, res, next) => {
  try {
    const user = await requireSuperAdmin(req, res);
    if (!user) return;
    const token = await apiTokenService.findById(intOr(req.params.id));
    if (!token || parseInt(token.user_id, 10) !== parseInt(user.id, 10)) {
      req.flash('error', 'Token not found or you do not have permission to revoke it.');
    } else {
      await apiTokenService.revoke(token.id);
      req.flash('success', 'API token revoked successfully.');
    }
    res.redirect(hamsUrl('/settings/api-tokens'));
  } catch (err) { next(err); }
});

// ─── Log Viewer (super admin only) ───
async function requireSuperAdminLogs(req, res) {
  const user = await currentUser(req);
  if (!(await authz.isSuperAdmin(user))) {
    req.flash('error', 'Only Super Administrators can access the log viewer.');
    res.redirect(hamsUrl('/'));
    return null;
  }
  return user;
}

router.get('/logs', authRequired, async (req, res, next) => {
  try {
    if (!(await requireSuperAdminLogs(req, res))) return;
    const filters = {
      level: req.query.level || '', search: req.query.search || '',
      date_from: req.query.date_from || '', date_to: req.query.date_to || '',
      user_id: req.query.user_id || '', file: req.query.file || logService.activeFile
    };
    const result = logService.search(filters, intOr(req.query.page, 1), intOr(req.query.per_page, 50));
    res.renderPage('logs/index', {
      ...result,
      stats: logService.getStats(),
      logFiles: logService.getLogFiles(),
      users: await logService.getUsersInLogs(db),
      filters,
      retention: await logService.getRetentionSettings(),
      active_tab: 'logs'
    });
  } catch (err) { next(err); }
});

router.get('/logs/show', authRequired, async (req, res, next) => {
  try {
    if (!(await requireSuperAdminLogs(req, res))) return;
    const file = String(req.query.file || '');
    const line = intOr(req.query.line, 0);
    if (!file || line <= 0) {
      req.flash('error', 'Invalid log entry reference.');
      return res.redirect(hamsUrl('/logs'));
    }
    const full = path.join(logService.logDir, path.basename(file));
    if (!fs.existsSync(full)) {
      req.flash('error', 'Invalid log file.');
      return res.redirect(hamsUrl('/logs'));
    }
    const entry = logService.getEntry(full, line);
    if (!entry) {
      req.flash('error', 'Log entry not found.');
      return res.redirect(hamsUrl('/logs'));
    }
    res.renderPage('logs/show', { entry, file: path.basename(file) });
  } catch (err) { next(err); }
});

router.post('/logs/clear', authRequired, csrfProtect, async (req, res, next) => {
  try {
    if (!(await requireSuperAdminLogs(req, res))) return;
    const file = req.body.file || null;
    logService.clearLogs(file);
    req.flash('success', file ? 'Log file cleared successfully.' : 'Logs cleared successfully.');
    res.redirect(hamsUrl('/logs'));
  } catch (err) { next(err); }
});

router.get('/logs/retention', authRequired, async (req, res, next) => {
  try {
    if (!(await requireSuperAdminLogs(req, res))) return;
    res.renderPage('logs/retention', {
      retention: await logService.getRetentionSettings(),
      logFiles: logService.getLogFiles(),
      active_tab: 'logs'
    });
  } catch (err) { next(err); }
});

router.post('/logs/retention', authRequired, csrfProtect, async (req, res, next) => {
  try {
    const user = await requireSuperAdminLogs(req, res);
    if (!user) return;
    await logService.updateRetentionSettings(req.body.retention_days, req.body.max_file_size_mb, user.id);
    req.flash('success', 'Log retention settings updated.');
    res.redirect(hamsUrl('/logs'));
  } catch (err) { next(err); }
});

router.post('/api/logs/search', authRequired, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!(await authz.isSuperAdmin(user))) {
      return res.status(403).json({ error: 'Only Super Administrators can access the log viewer.' });
    }
    const filters = {
      level: req.body.level || '', search: req.body.search || '',
      date_from: req.body.date_from || '', date_to: req.body.date_to || '',
      user_id: req.body.user_id || '', file: req.body.file || logService.activeFile
    };
    res.json(logService.search(filters, intOr(req.body.page, 1), intOr(req.body.per_page, 50)));
  } catch (err) { next(err); }
});

module.exports = router;
