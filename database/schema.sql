-- IT-HAMS Enterprise Master Schema (PostgreSQL)
-- Ported from HAMS MySQL master schema v1.8.0

-- updated_at trigger helper (replaces MySQL ON UPDATE CURRENT_TIMESTAMP)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. Core System Infrastructure
CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    migration VARCHAR(255) NOT NULL,
    batch INT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    id SERIAL PRIMARY KEY,
    group_key VARCHAR(50) NOT NULL,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    setting_type VARCHAR(20) DEFAULT 'string',
    is_encrypted BOOLEAN DEFAULT FALSE,
    is_system BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (group_key, setting_key)
);

CREATE TABLE IF NOT EXISTS modules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    label VARCHAR(100) NOT NULL,
    icon VARCHAR(50) DEFAULT 'box',
    description TEXT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Identity & Access Management (IAM)
CREATE TABLE IF NOT EXISTS locations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    country VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS sub_locations (
    id SERIAL PRIMARY KEY,
    location_id INT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NULL,
    floor VARCHAR(50) NULL,
    room VARCHAR(50) NULL,
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_locations_location_id ON sub_locations (location_id);

CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    parent_id INT NULL REFERENCES departments(id) ON DELETE SET NULL,
    manager_id INT NULL,
    cost_center VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    uuid CHAR(36) UNIQUE,
    employee_id VARCHAR(50) UNIQUE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    auth_source VARCHAR(30) DEFAULT 'local',
    external_id VARCHAR(191) NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending', 'archived')),
    department_id INT NULL REFERENCES departments(id) ON DELETE SET NULL,
    location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    manager_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
    avatar_url VARCHAR(255) NULL,
    two_factor_secret VARCHAR(100) NULL,
    two_factor_enabled BOOLEAN DEFAULT FALSE,
    two_factor_recovery_codes TEXT NULL,
    ldap_dn VARCHAR(500) NULL,
    ldap_can_login BOOLEAN DEFAULT FALSE,
    ldap_last_synced_at TIMESTAMP NULL,
    last_login_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

ALTER TABLE departments DROP CONSTRAINT IF EXISTS fk_departments_manager;
ALTER TABLE departments ADD CONSTRAINT fk_departments_manager
    FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100),
    description TEXT,
    level INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    module_id INT NULL REFERENCES modules(id) ON DELETE CASCADE,
    module VARCHAR(50) NOT NULL,
    action VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_location_scopes (
    role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    location_id INT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, location_id)
);

CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    email VARCHAR(191) NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets (email);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets (token);

-- express-session store (connect-pg-simple compatible), replaces MySQL `sessions`
CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR NOT NULL PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire);

-- 3. Inventory Foundation
CREATE TABLE IF NOT EXISTS manufacturers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL UNIQUE,
    url VARCHAR(255),
    support_url VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL UNIQUE,
    contact_name VARCHAR(150),
    email VARCHAR(150),
    phone VARCHAR(50),
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS procurement_records (
    id SERIAL PRIMARY KEY,
    po_number VARCHAR(100) NULL,
    invoice_number VARCHAR(100) NULL,
    vendor_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    purchase_date DATE NULL,
    total_amount DECIMAL(15,2) NULL,
    currency VARCHAR(10) DEFAULT 'USD',
    invoice_file_path VARCHAR(255) NULL,
    po_file_path VARCHAR(255) NULL,
    notes TEXT NULL,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS asset_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    type VARCHAR(50) NOT NULL DEFAULT 'asset',
    color VARCHAR(20) DEFAULT '#3b82f6',
    requires_acceptance BOOLEAN DEFAULT FALSE,
    send_checkout_email BOOLEAN DEFAULT TRUE,
    fieldset_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS status_labels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    type VARCHAR(50) NOT NULL DEFAULT 'deployable',
    color VARCHAR(20) DEFAULT '#3b82f6',
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS asset_models (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    model_number VARCHAR(100),
    manufacturer_id INT NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE SET NULL,
    default_warranty_months INT DEFAULT 12,
    eol_months INT NULL,
    image_url VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,
    UNIQUE (name, model_number)
);

-- 4. Core Inventory Entities
CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    asset_tag VARCHAR(100) UNIQUE,
    label_token VARCHAR(64) UNIQUE,
    name VARCHAR(255) NOT NULL,
    asset_model_id INT NULL REFERENCES asset_models(id) ON DELETE SET NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE RESTRICT,
    manufacturer_id INT NULL REFERENCES manufacturers(id) ON DELETE RESTRICT,
    supplier_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    procurement_id INT NULL REFERENCES procurement_records(id) ON DELETE SET NULL,
    location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    sub_location_id INT NULL REFERENCES sub_locations(id) ON DELETE SET NULL,
    serial_number VARCHAR(100) UNIQUE,
    model_number VARCHAR(100),
    category VARCHAR(100),
    status VARCHAR(50) DEFAULT 'available',
    status_label_id INT NULL REFERENCES status_labels(id) ON DELETE SET NULL,
    purchase_date DATE,
    purchase_cost DECIMAL(12,2) NULL,
    depreciation_months INT NULL,
    salvage_value DECIMAL(12,2) NULL,
    warranty_expiry DATE,
    assigned_to INT NULL REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT,
    custom_fields_data JSONB NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_location_id ON assets (location_id);
CREATE INDEX IF NOT EXISTS idx_assets_sub_location_id ON assets (sub_location_id);
CREATE INDEX IF NOT EXISTS idx_assets_supplier_id ON assets (supplier_id);
CREATE INDEX IF NOT EXISTS idx_assets_manufacturer_id ON assets (manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_assets_status_label_id ON assets (status_label_id);

CREATE TABLE IF NOT EXISTS accessories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE SET NULL,
    manufacturer_id INT NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    supplier_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    sub_location_id INT NULL REFERENCES sub_locations(id) ON DELETE SET NULL,
    model_number VARCHAR(100),
    serial_number VARCHAR(100) NULL,
    total_qty INT DEFAULT 0,
    available_qty INT DEFAULT 0,
    min_qty INT DEFAULT 0,
    notes TEXT,
    custom_fields_data JSONB NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS consumables (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE SET NULL,
    manufacturer_id INT NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    supplier_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    sub_location_id INT NULL REFERENCES sub_locations(id) ON DELETE SET NULL,
    total_qty INT DEFAULT 0,
    remaining_qty INT DEFAULT 0,
    min_qty INT DEFAULT 0,
    notes TEXT,
    custom_fields_data JSONB NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS components (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE SET NULL,
    manufacturer_id INT NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    supplier_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    sub_location_id INT NULL REFERENCES sub_locations(id) ON DELETE SET NULL,
    serial_number VARCHAR(100),
    total_qty INT DEFAULT 0,
    available_qty INT DEFAULT 0,
    min_qty INT DEFAULT 0,
    notes TEXT,
    custom_fields_data JSONB NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE SET NULL,
    manufacturer_id INT NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    supplier_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    sub_location_id INT NULL REFERENCES sub_locations(id) ON DELETE SET NULL,
    license_supplier_id INT NULL,
    license_manufacturer_id INT NULL,
    seats INT DEFAULT 1,
    available_seats INT DEFAULT 1,
    license_key TEXT,
    product_key VARCHAR(255) NULL,
    order_number VARCHAR(100) NULL,
    purchase_order_number VARCHAR(100) NULL,
    purchase_date DATE NULL,
    purchase_cost DECIMAL(12,2) NULL,
    expiration_date DATE NULL,
    termination_date DATE NULL,
    purchase_type VARCHAR(50) NULL,
    license_type VARCHAR(50) NULL,
    maintained BOOLEAN DEFAULT FALSE,
    reassignable BOOLEAN DEFAULT TRUE,
    checkout_email BOOLEAN DEFAULT FALSE,
    licensed_to_name VARCHAR(150) NULL,
    licensed_to_email VARCHAR(150) NULL,
    notes TEXT,
    custom_fields_data JSONB NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_location_id ON licenses (location_id);
CREATE INDEX IF NOT EXISTS idx_licenses_sub_location_id ON licenses (sub_location_id);

-- 5. Workflow & Operations
CREATE TABLE IF NOT EXISTS assignments (
    id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checked_out_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    checked_in_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expected_return_at DATE NULL,
    returned_at TIMESTAMP NULL,
    checkout_condition VARCHAR(50) NULL,
    checkin_condition VARCHAR(50) NULL,
    checkout_notes TEXT,
    checkin_notes TEXT,
    accepted_at TIMESTAMP NULL,
    acceptance_ip VARCHAR(45) NULL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS accessory_assignments (
    id SERIAL PRIMARY KEY,
    accessory_id INT NOT NULL REFERENCES accessories(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    qty INT DEFAULT 1,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    returned_at TIMESTAMP NULL,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_acc_ass_acc_ret ON accessory_assignments (accessory_id, returned_at);

CREATE TABLE IF NOT EXISTS consumable_issues (
    id SERIAL PRIMARY KEY,
    consumable_id INT NOT NULL REFERENCES consumables(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    qty INT DEFAULT 1,
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS component_assignments (
    id SERIAL PRIMARY KEY,
    component_id INT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    asset_id INT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    qty INT DEFAULT 1,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP NULL,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_comp_ass_comp_rem ON component_assignments (component_id, removed_at);

CREATE TABLE IF NOT EXISTS license_assignments (
    id SERIAL PRIMARY KEY,
    license_id INT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    user_id INT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id INT NULL REFERENCES assets(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP NULL,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_lic_ass_lic_rev ON license_assignments (license_id, revoked_at);

CREATE TABLE IF NOT EXISTS asset_maintenance (
    id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    vendor_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    title VARCHAR(150) NOT NULL,
    maintenance_type VARCHAR(50) DEFAULT 'repair',
    status VARCHAR(50) DEFAULT 'open',
    start_date DATE NULL,
    completion_date DATE NULL,
    cost DECIMAL(12,2) NULL,
    recurrence VARCHAR(50) NULL,
    next_due_date DATE NULL,
    downtime_hours DECIMAL(8,2) NULL,
    notes TEXT,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS asset_requests (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id INT NULL REFERENCES assets(id) ON DELETE SET NULL,
    asset_model_id INT NULL REFERENCES asset_models(id) ON DELETE SET NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE SET NULL,
    title VARCHAR(150) NOT NULL,
    business_justification TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    reviewed_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT,
    fulfilled_asset_id INT NULL REFERENCES assets(id) ON DELETE SET NULL,
    fulfilled_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS asset_reservations (
    id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reserved_from DATE NULL,
    reserved_until DATE NULL,
    status VARCHAR(50) DEFAULT 'active',
    notes TEXT,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL DEFAULT 'asset',
    entity_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    file_url VARCHAR(255),
    attachment_type VARCHAR(50) DEFAULT 'document',
    notes TEXT,
    uploaded_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity_logs (
    id SERIAL PRIMARY KEY,
    user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(255),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON activity_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    delivery_status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id INT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS login_rate_limits (
    id SERIAL PRIMARY KEY,
    rate_key VARCHAR(100) NOT NULL UNIQUE,
    attempts INT NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    abilities JSONB NULL,
    last_used_at TIMESTAMP NULL,
    last_ip VARCHAR(45) NULL,
    expires_at TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_revoked_at ON api_tokens (revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_tokens_expires_at ON api_tokens (expires_at);

CREATE TABLE IF NOT EXISTS api_rate_limits (
    id SERIAL PRIMARY KEY,
    token_id INT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    endpoint VARCHAR(100) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    window_start TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (token_id, endpoint, window_start)
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_window ON api_rate_limits (token_id, endpoint, window_start);

CREATE TABLE IF NOT EXISTS backup_jobs (
    id SERIAL PRIMARY KEY,
    backup_type VARCHAR(20) NOT NULL DEFAULT 'database' CHECK (backup_type IN ('database', 'code', 'full')),
    status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    file_name VARCHAR(255) NULL,
    file_path VARCHAR(500) NULL,
    file_size BIGINT DEFAULT 0,
    checksum VARCHAR(64) NULL,
    destination_type VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (destination_type IN ('local', 'network', 'ftp', 'sftp')),
    destination_path VARCHAR(500) NULL,
    message TEXT NULL,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS backup_schedules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    backup_type VARCHAR(20) NOT NULL DEFAULT 'database' CHECK (backup_type IN ('database', 'code', 'full')),
    frequency VARCHAR(20) NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    run_time TIME NOT NULL DEFAULT '02:00:00',
    retention_days INT NOT NULL DEFAULT 30,
    destination_type VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (destination_type IN ('local', 'network', 'ftp', 'sftp')),
    destination_path VARCHAR(500) NULL,
    host VARCHAR(255) NULL,
    port INT NULL,
    username VARCHAR(255) NULL,
    password VARCHAR(500) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMP NULL,
    next_run_at TIMESTAMP NULL,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'completed',
    rows_total INT DEFAULT 0,
    rows_imported INT DEFAULT 0,
    errors TEXT,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_schedules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    module_key VARCHAR(50) NOT NULL,
    format VARCHAR(20) DEFAULT 'csv',
    frequency VARCHAR(20) DEFAULT 'daily',
    run_time TIME DEFAULT '08:00:00',
    delivery VARCHAR(20) DEFAULT 'both',
    recipients TEXT NULL,
    filters_json TEXT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_run_at TIMESTAMP NULL,
    next_run_at TIMESTAMP NULL,
    last_status VARCHAR(50) NULL,
    last_file_path VARCHAR(500) NULL,
    last_message TEXT NULL,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS ldap_directory_users (
    id SERIAL PRIMARY KEY,
    local_user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
    external_id VARCHAR(191) NULL,
    dn VARCHAR(500) NOT NULL UNIQUE,
    username VARCHAR(191) NULL,
    email VARCHAR(191) NULL,
    display_name VARCHAR(191) NOT NULL,
    department VARCHAR(191) NULL,
    title VARCHAR(191) NULL,
    phone VARCHAR(100) NULL,
    sync_status VARCHAR(20) DEFAULT 'active' CHECK (sync_status IN ('active', 'missing', 'disabled')),
    can_login BOOLEAN DEFAULT FALSE,
    role_name VARCHAR(50) DEFAULT 'employee',
    last_changed_at VARCHAR(50) NULL,
    first_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ldap_sync_jobs (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(20) NOT NULL CHECK (sync_type IN ('full', 'incremental')),
    status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP NULL,
    total_seen INT DEFAULT 0,
    created_count INT DEFAULT 0,
    updated_count INT DEFAULT 0,
    linked_count INT DEFAULT 0,
    error_message TEXT NULL,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS custom_fields (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    field_key VARCHAR(100) NOT NULL UNIQUE,
    field_type VARCHAR(20) DEFAULT 'text' CHECK (field_type IN ('text', 'number', 'date', 'select', 'boolean')),
    options TEXT NULL,
    is_required BOOLEAN DEFAULT FALSE,
    is_filterable BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_fieldsets (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    module_key VARCHAR(50) DEFAULT 'assets',
    description TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_fieldset_field (
    fieldset_id INT NOT NULL REFERENCES custom_fieldsets(id) ON DELETE CASCADE,
    field_id INT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
    order_rank INT DEFAULT 0,
    PRIMARY KEY (fieldset_id, field_id)
);

CREATE TABLE IF NOT EXISTS custom_fieldset_module (
    id SERIAL PRIMARY KEY,
    fieldset_id INT NOT NULL REFERENCES custom_fieldsets(id) ON DELETE CASCADE,
    module_key VARCHAR(50) NOT NULL,
    category_id INT NULL REFERENCES asset_categories(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fieldset_id, module_key, category_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id SERIAL PRIMARY KEY,
    module_key VARCHAR(50) NOT NULL,
    item_id INT NOT NULL,
    movement_type VARCHAR(50) NULL,
    direction VARCHAR(3) NOT NULL CHECK (direction IN ('in', 'out')),
    quantity INT DEFAULT 1,
    from_location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    to_location_id INT NULL REFERENCES locations(id) ON DELETE SET NULL,
    holder_user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
    vendor_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    related_assignment_id INT NULL,
    related_maintenance_id INT NULL,
    effective_status VARCHAR(50) NULL,
    reason VARCHAR(100),
    reference VARCHAR(150),
    notes TEXT,
    occurred_at TIMESTAMP NULL,
    reversal_of_id INT NULL,
    is_reversal BOOLEAN NOT NULL DEFAULT FALSE,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_movements_occurred_at ON stock_movements (occurred_at);
CREATE INDEX IF NOT EXISTS idx_movements_from_location_id ON stock_movements (from_location_id);
CREATE INDEX IF NOT EXISTS idx_movements_to_location_id ON stock_movements (to_location_id);
CREATE INDEX IF NOT EXISTS idx_movements_holder_user_id ON stock_movements (holder_user_id);
CREATE INDEX IF NOT EXISTS idx_movements_reversal_of_id ON stock_movements (reversal_of_id);
CREATE INDEX IF NOT EXISTS idx_movements_module_item ON stock_movements (module_key, item_id);

CREATE TABLE IF NOT EXISTS grn_records (
    id SERIAL PRIMARY KEY,
    procurement_id INT NULL REFERENCES procurement_records(id) ON DELETE SET NULL,
    grn_number VARCHAR(100) NOT NULL UNIQUE,
    received_date DATE NULL,
    qc_status VARCHAR(50) DEFAULT 'pending',
    received_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_grn_procurement_id ON grn_records (procurement_id);

CREATE TABLE IF NOT EXISTS grn_items (
    id SERIAL PRIMARY KEY,
    grn_id INT NOT NULL REFERENCES grn_records(id) ON DELETE CASCADE,
    item_type VARCHAR(50) DEFAULT 'asset',
    item_name VARCHAR(150) NOT NULL,
    ordered_qty INT DEFAULT 0,
    received_qty INT DEFAULT 0,
    accepted_qty INT DEFAULT 0,
    rejected_qty INT DEFAULT 0,
    qc_notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_grn_items_composite ON grn_items (grn_id, item_type);

CREATE TABLE IF NOT EXISTS inventory_workflow_notes (
    id SERIAL PRIMARY KEY,
    module_key VARCHAR(50) NOT NULL,
    item_id INT NOT NULL,
    action VARCHAR(50) NOT NULL,
    subject_id INT NULL,
    quantity INT DEFAULT 1,
    notes TEXT NULL,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_permissions_cache (
    user_id INT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    permissions_json TEXT NOT NULL,
    refreshed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Automation Engine
CREATE TABLE IF NOT EXISTS automation_rules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    event_trigger VARCHAR(100) NOT NULL,
    conditions TEXT,
    actions TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automation_logs (
    id SERIAL PRIMARY KEY,
    automation_rule_id INT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    trigger_payload TEXT,
    status VARCHAR(50) NOT NULL,
    message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- License Setup Tables
CREATE TABLE IF NOT EXISTS license_manufacturers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    website VARCHAR(255),
    support_url VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS license_suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    contact_name VARCHAR(150),
    email VARCHAR(150),
    phone VARCHAR(100),
    website VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

-- Purchase Orders
CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL PRIMARY KEY,
    po_number VARCHAR(100) NOT NULL,
    supplier_id INT NULL REFERENCES suppliers(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'draft',
    order_date DATE,
    expected_date DATE,
    total_amount DECIMAL(12,2),
    notes TEXT,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url VARCHAR(255) NOT NULL,
    events TEXT NOT NULL,
    secret VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id SERIAL PRIMARY KEY,
    webhook_id INT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event VARCHAR(100) NOT NULL,
    payload TEXT NOT NULL,
    status VARCHAR(50) NOT NULL,
    response_code INT,
    response_body TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Settings History
CREATE TABLE IF NOT EXISTS settings_history (
    id SERIAL PRIMARY KEY,
    setting_id INT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Password Reset Tokens (framework-compatible)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    email VARCHAR(255) NOT NULL PRIMARY KEY,
    token VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NULL
);

-- Queue Tables (DB fallback)
CREATE TABLE IF NOT EXISTS jobs (
    id BIGSERIAL PRIMARY KEY,
    queue VARCHAR(255) NOT NULL,
    payload TEXT NOT NULL,
    attempts SMALLINT NOT NULL,
    reserved_at BIGINT NULL,
    available_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs (queue);

CREATE TABLE IF NOT EXISTS job_batches (
    id VARCHAR(255) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    total_jobs INT NOT NULL,
    pending_jobs INT NOT NULL,
    failed_jobs INT NOT NULL,
    failed_job_ids TEXT NOT NULL,
    options TEXT,
    cancelled_at INT NULL,
    created_at INT NOT NULL,
    finished_at INT NULL
);

CREATE TABLE IF NOT EXISTS failed_jobs (
    id BIGSERIAL PRIMARY KEY,
    uuid VARCHAR(255) NOT NULL UNIQUE,
    connection TEXT NOT NULL,
    queue TEXT NOT NULL,
    payload TEXT NOT NULL,
    exception TEXT NOT NULL,
    failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Cache Tables
CREATE TABLE IF NOT EXISTS cache (
    key VARCHAR(255) NOT NULL PRIMARY KEY,
    value TEXT NOT NULL,
    expiration INT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_locks (
    key VARCHAR(255) NOT NULL PRIMARY KEY,
    owner VARCHAR(255) NOT NULL,
    expiration INT NOT NULL
);

-- updated_at triggers for all tables that carry updated_at
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'updated_at'
        GROUP BY table_name
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
        EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END LOOP;
END;
$$;
