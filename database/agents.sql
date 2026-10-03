-- Real-time endpoint agents.
-- An agent installed on a user's machine enrolls once (full system details),
-- receives a unique token, then sends a heartbeat every ~15 minutes.
-- Enrollment is gated by a shared enrollment key (rotatable by admins).
-- Agent-reported assets reuse asset_monitors/asset_health_status (method = 'agent').

CREATE TABLE IF NOT EXISTS agent_enrollment_keys (
    id SERIAL PRIMARY KEY,
    enrollment_key VARCHAR(80) NOT NULL UNIQUE,
    label VARCHAR(120) NOT NULL DEFAULT 'Default enrollment key',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed one active enrollment key if none exists yet.
INSERT INTO agent_enrollment_keys (enrollment_key, label)
SELECT 'HAMS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 24)),
       'Default enrollment key'
WHERE NOT EXISTS (SELECT 1 FROM agent_enrollment_keys);

CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    agent_uid VARCHAR(64) NOT NULL UNIQUE,
    token_hash VARCHAR(64) NOT NULL,             -- sha256 of the agent's bearer token
    asset_id INT NULL REFERENCES assets(id) ON DELETE SET NULL,
    platform VARCHAR(20) NOT NULL DEFAULT 'unknown',  -- windows | mac | linux
    hostname VARCHAR(255) NULL,
    os VARCHAR(120) NULL,
    os_version VARCHAR(120) NULL,
    cpu_model VARCHAR(255) NULL,
    cpu_cores INT NULL,
    ram_mb INT NULL,
    disk_total_gb NUMERIC(10,1) NULL,
    disk_free_gb NUMERIC(10,1) NULL,
    mac_address VARCHAR(64) NULL,
    ip_address VARCHAR(64) NULL,
    logged_in_user VARCHAR(150) NULL,
    serial_number VARCHAR(120) NULL,
    manufacturer VARCHAR(150) NULL,
    model VARCHAR(150) NULL,
    agent_version VARCHAR(20) NULL,
    uptime_sec BIGINT NULL,
    heartbeat_count INT DEFAULT 0,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agents_asset ON agents (asset_id);
CREATE INDEX IF NOT EXISTS idx_agents_last_hb ON agents (last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_serial ON agents (serial_number);

CREATE TABLE IF NOT EXISTS agent_metrics (
    id SERIAL PRIMARY KEY,
    agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    cpu_percent NUMERIC(5,2) NULL,
    ram_used_mb INT NULL,
    disk_free_gb NUMERIC(10,1) NULL,
    uptime_sec BIGINT NULL,
    ip_address VARCHAR(64) NULL,
    logged_in_user VARCHAR(150) NULL,
    reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_time ON agent_metrics (agent_id, reported_at DESC);

-- Agent-reported assets reuse the health tables; allow 'agent' as a check method
-- and 'UNSTABLE' as a status (idempotent constraint swaps).
ALTER TABLE asset_monitors DROP CONSTRAINT IF EXISTS asset_monitors_check_method_check;
ALTER TABLE asset_monitors ADD CONSTRAINT asset_monitors_check_method_check
    CHECK (check_method IN ('icmp', 'tcp', 'http', 'agent'));

ALTER TABLE asset_health_status DROP CONSTRAINT IF EXISTS asset_health_status_status_check;
ALTER TABLE asset_health_status ADD CONSTRAINT asset_health_status_status_check
    CHECK (status IN ('UP', 'DOWN', 'UNSTABLE', 'UNKNOWN'));
