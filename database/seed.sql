-- IT-HAMS Seed Data (ported from HAMS master schema seed section)

INSERT INTO roles (name, display_name, description, level) VALUES
('super_admin', 'Super Administrator', 'Full system access', 100),
('it_admin', 'IT Administrator', 'Manage assets and users', 80),
('asset_manager', 'Asset Manager', 'Inventory management only', 50),
('employee', 'Standard Employee', 'View own assets only', 10)
ON CONFLICT (name) DO NOTHING;

INSERT INTO modules (name, label, icon, description, is_active) VALUES
('assets', 'Asset Management', 'laptop', 'Hardware assets, labels, checkout, and check-in workflows.', TRUE),
('inventory', 'Inventory Module', 'package', 'Accessories, consumables, components, stock, and setup records.', TRUE),
('licenses', 'License Management', 'key-round', 'Software licenses, seats, keys, expiry, and assignments.', TRUE),
('maintenance', 'Maintenance', 'wrench', 'Maintenance records, warranty work, repairs, and downtime.', TRUE),
('requests', 'Requests', 'clipboard-list', 'Employee asset requests and approval workflows.', TRUE),
('reports', 'Reports & Import Export', 'file-bar-chart', 'Reports, exports, imports, analytics, and advanced lifecycle tools.', TRUE),
('personnel', 'Personnel & Access', 'users', 'Users, departments, roles, permissions, and access scopes.', TRUE),
('settings', 'System Settings', 'settings', 'Branding, organization, security, identity, and monitoring settings.', TRUE),
('audit', 'Audit Trails', 'shield-check', 'Audit log visibility and security event review.', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO asset_categories (name, type, color, requires_acceptance) VALUES
('Laptop', 'asset', '#3b82f6', TRUE),
('Desktop', 'asset', '#6366f1', TRUE),
('Monitor', 'asset', '#06b6d4', FALSE),
('Server', 'asset', '#8b5cf6', FALSE),
('Network Device', 'asset', '#14b8a6', FALSE),
('Mobile Device', 'asset', '#f59e0b', TRUE),
('Accessory', 'accessory', '#64748b', FALSE),
('Consumable', 'consumable', '#22c55e', FALSE),
('Component', 'component', '#f97316', FALSE),
('License', 'license', '#ec4899', FALSE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO status_labels (name, type, color, is_default) VALUES
('Ready to Deploy', 'deployable', '#22c55e', TRUE),
('In Stock', 'deployable', '#22c55e', FALSE),
('Deployed', 'deployed', '#3b82f6', FALSE),
('Pending', 'pending', '#f59e0b', FALSE),
('Reserved', 'pending', '#a855f7', FALSE),
('In Repair', 'undeployable', '#f97316', FALSE),
('Broken', 'undeployable', '#ef4444', FALSE),
('Damaged', 'undeployable', '#dc2626', FALSE),
('Lost', 'archived', '#64748b', FALSE),
('Retired', 'archived', '#71717a', FALSE),
('Disposed', 'archived', '#52525b', FALSE)
ON CONFLICT (name) DO NOTHING;

-- Permissions (module_id references modules by seeded id order: 1..9 as above)
INSERT INTO permissions (module_id, module, action, name) VALUES
(NULL, 'dashboard', 'view', 'dashboard.view'),
((SELECT id FROM modules WHERE name='assets'), 'assets', 'view', 'assets.view'),
((SELECT id FROM modules WHERE name='assets'), 'assets', 'create', 'assets.create'),
((SELECT id FROM modules WHERE name='assets'), 'assets', 'edit', 'assets.edit'),
((SELECT id FROM modules WHERE name='assets'), 'assets', 'delete', 'assets.delete'),
((SELECT id FROM modules WHERE name='assets'), 'assets', 'manage', 'assets.manage'),
((SELECT id FROM modules WHERE name='assets'), 'assets', 'checkout', 'assets.checkout'),
((SELECT id FROM modules WHERE name='inventory'), 'inventory', 'view', 'inventory.view'),
((SELECT id FROM modules WHERE name='inventory'), 'inventory', 'create', 'inventory.create'),
((SELECT id FROM modules WHERE name='inventory'), 'inventory', 'edit', 'inventory.edit'),
((SELECT id FROM modules WHERE name='inventory'), 'inventory', 'delete', 'inventory.delete'),
((SELECT id FROM modules WHERE name='inventory'), 'inventory', 'manage', 'inventory.manage'),
((SELECT id FROM modules WHERE name='licenses'), 'licenses', 'view', 'licenses.view'),
((SELECT id FROM modules WHERE name='licenses'), 'licenses', 'create', 'licenses.create'),
((SELECT id FROM modules WHERE name='licenses'), 'licenses', 'edit', 'licenses.edit'),
((SELECT id FROM modules WHERE name='licenses'), 'licenses', 'delete', 'licenses.delete'),
((SELECT id FROM modules WHERE name='licenses'), 'licenses', 'manage', 'licenses.manage'),
((SELECT id FROM modules WHERE name='licenses'), 'licenses', 'manage_setup', 'licenses.manage_setup'),
((SELECT id FROM modules WHERE name='maintenance'), 'maintenance', 'view', 'maintenance.view'),
((SELECT id FROM modules WHERE name='maintenance'), 'maintenance', 'create', 'maintenance.create'),
((SELECT id FROM modules WHERE name='maintenance'), 'maintenance', 'edit', 'maintenance.edit'),
((SELECT id FROM modules WHERE name='maintenance'), 'maintenance', 'delete', 'maintenance.delete'),
((SELECT id FROM modules WHERE name='maintenance'), 'maintenance', 'manage', 'maintenance.manage'),
((SELECT id FROM modules WHERE name='requests'), 'requests', 'view', 'requests.view'),
((SELECT id FROM modules WHERE name='requests'), 'requests', 'create', 'requests.create'),
((SELECT id FROM modules WHERE name='requests'), 'requests', 'edit', 'requests.edit'),
((SELECT id FROM modules WHERE name='requests'), 'requests', 'delete', 'requests.delete'),
((SELECT id FROM modules WHERE name='requests'), 'requests', 'manage', 'requests.manage'),
((SELECT id FROM modules WHERE name='requests'), 'requests', 'approve', 'requests.approve'),
((SELECT id FROM modules WHERE name='reports'), 'reports', 'view', 'reports.view'),
((SELECT id FROM modules WHERE name='reports'), 'reports', 'create', 'reports.create'),
((SELECT id FROM modules WHERE name='reports'), 'reports', 'edit', 'reports.edit'),
((SELECT id FROM modules WHERE name='reports'), 'reports', 'manage', 'reports.manage'),
((SELECT id FROM modules WHERE name='reports'), 'reports', 'schedule', 'reports.schedule'),
((SELECT id FROM modules WHERE name='personnel'), 'personnel', 'view', 'personnel.view'),
((SELECT id FROM modules WHERE name='personnel'), 'personnel', 'create', 'personnel.create'),
((SELECT id FROM modules WHERE name='personnel'), 'personnel', 'edit', 'personnel.edit'),
((SELECT id FROM modules WHERE name='personnel'), 'personnel', 'delete', 'personnel.delete'),
((SELECT id FROM modules WHERE name='personnel'), 'personnel', 'manage', 'personnel.manage'),
((SELECT id FROM modules WHERE name='settings'), 'settings', 'view', 'settings.view'),
((SELECT id FROM modules WHERE name='settings'), 'settings', 'create', 'settings.create'),
((SELECT id FROM modules WHERE name='settings'), 'settings', 'edit', 'settings.edit'),
((SELECT id FROM modules WHERE name='settings'), 'settings', 'manage', 'settings.manage'),
((SELECT id FROM modules WHERE name='audit'), 'audit', 'view', 'audit.view'),
((SELECT id FROM modules WHERE name='audit'), 'audit', 'manage', 'audit.manage'),
(NULL, 'api_tokens', 'view', 'api_tokens.view'),
(NULL, 'api_tokens', 'create', 'api_tokens.create'),
(NULL, 'api_tokens', 'revoke', 'api_tokens.revoke'),
(NULL, 'api_tokens', 'manage', 'api_tokens.manage')
ON CONFLICT (name) DO NOTHING;

-- Role permission grants (mirrors MySQL seed logic)
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='super_admin'), p.id FROM permissions p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='it_admin'), p.id FROM permissions p
WHERE p.module IN ('assets', 'inventory', 'licenses', 'maintenance', 'requests', 'reports', 'personnel', 'audit', 'api_tokens')
AND p.action IN ('view', 'create', 'edit', 'delete', 'manage', 'checkout', 'approve', 'schedule', 'manage_setup', 'revoke')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='asset_manager'), p.id FROM permissions p
WHERE p.module IN ('assets', 'inventory', 'licenses', 'maintenance', 'reports', 'api_tokens')
AND p.action IN ('view', 'create', 'edit', 'delete', 'manage', 'checkout', 'revoke')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name='employee'), p.id FROM permissions p
WHERE p.name IN ('requests.view', 'requests.create', 'dashboard.view')
ON CONFLICT DO NOTHING;

INSERT INTO settings (group_key, setting_key, setting_value, setting_type) VALUES
('branding', 'app_name', 'HAMS Enterprise', 'string'),
('branding', 'app_tagline', 'Enterprise Asset Management', 'string'),
('branding', 'primary_color', '#3b82f6', 'string'),
('branding', 'sidebar_theme', 'dark', 'string'),
('branding', 'app_logo', '', 'string'),
('organization', 'timezone', 'UTC', 'string'),
('organization', 'currency', 'USD', 'string'),
('organization', 'asset_prefix', 'HAMS-', 'string'),
('organization', 'default_warranty', '36', 'integer'),
('security', 'mfa_required', '0', 'boolean'),
('security', 'two_factor_system_enabled', '0', 'boolean'),
('security', 'session_timeout', '3600', 'integer'),
('security', 'rate_limit_login_attempts', '5', 'integer'),
('security', 'rate_limit_lockout_seconds', '300', 'integer'),
('security', 'pwd_min_length', '12', 'integer'),
('security', 'pwd_special', '1', 'boolean'),
('identity', 'ldap_enabled', '0', 'boolean'),
('identity', 'ldap_host', '', 'string'),
('identity', 'ldap_port', '389', 'integer'),
('identity', 'ldap_base_dn', '', 'string'),
('identity', 'ldap_bind_dn', '', 'string'),
('identity', 'ldap_bind_password', '', 'string'),
('identity', 'ldap_tls', '0', 'boolean'),
('identity', 'ldap_user_filter', '(|(mail={login})(userPrincipalName={login})(sAMAccountName={login}))', 'string'),
('identity', 'ldap_email_attribute', 'mail', 'string'),
('identity', 'ldap_name_attribute', 'cn', 'string'),
('identity', 'ldap_auto_provision', '0', 'boolean'),
('identity', 'saml_enabled', '0', 'boolean'),
('identity', 'saml_sso_url', '', 'string'),
('identity', 'saml_entity_id', '', 'string'),
('identity', 'saml_acs_url', '', 'string'),
('identity', 'saml_certificate', '', 'string'),
('identity', 'saml_auto_provision', '0', 'boolean'),
('identity', 'oidc_enabled', '0', 'boolean'),
('identity', 'oidc_client_id', '', 'string'),
('identity', 'oidc_client_secret', '', 'string'),
('identity', 'oidc_authorization_url', '', 'string'),
('identity', 'oidc_token_url', '', 'string'),
('identity', 'oidc_userinfo_url', '', 'string'),
('identity', 'oidc_redirect_uri', '', 'string'),
('identity', 'oidc_scopes', 'openid email profile', 'string'),
('identity', 'oidc_auto_provision', '0', 'boolean'),
('notifications', 'email_enabled', '0', 'boolean'),
('notifications', 'smtp_host', '', 'string'),
('notifications', 'smtp_port', '587', 'integer'),
('notifications', 'smtp_username', '', 'string'),
('notifications', 'smtp_password', '', 'string'),
('notifications', 'smtp_encryption', 'tls', 'string'),
('notifications', 'mail_from', 'no-reply@hams.local', 'string'),
('notifications', 'backup_failure_email', '1', 'boolean'),
('monitoring', 'audit_retention_days', '365', 'integer'),
('monitoring', 'health_alerts_enabled', '1', 'boolean'),
('backup', 'auto_backup_enabled', '0', 'boolean'),
('archive', 'retention_days', '7', 'integer')
ON CONFLICT (group_key, setting_key) DO NOTHING;
