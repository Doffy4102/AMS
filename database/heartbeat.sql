-- Asset Health Check (heartbeat) module
-- Monitoring config + current status + history + alerts. Follows schema.sql style:
-- idempotent DDL, SERIAL PKs, explicit indexes.

CREATE TABLE IF NOT EXISTS asset_monitors (
    id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL UNIQUE REFERENCES assets(id) ON DELETE CASCADE,
    hostname VARCHAR(255) NULL,
    ip_address VARCHAR(45) NULL,
    check_method VARCHAR(10) NOT NULL DEFAULT 'icmp' CHECK (check_method IN ('icmp', 'tcp', 'http')),
    port INT NULL,
    health_url VARCHAR(500) NULL,
    monitoring_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_asset_monitors_enabled ON asset_monitors (monitoring_enabled);

CREATE TABLE IF NOT EXISTS asset_health_status (
    asset_id INT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    status VARCHAR(10) NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UP', 'DOWN', 'UNSTABLE', 'UNKNOWN')),
    latency_ms NUMERIC(10, 2) NULL,
    check_method VARCHAR(10) NULL,
    target VARCHAR(500) NULL,
    error TEXT NULL,
    consecutive_failures INT DEFAULT 0,
    last_checked_at TIMESTAMP NULL,
    last_change_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS asset_heartbeats (
    id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    status VARCHAR(10) NOT NULL,
    latency_ms NUMERIC(10, 2) NULL,
    check_method VARCHAR(10) NOT NULL,
    target VARCHAR(500) NULL,
    error TEXT NULL,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_asset_heartbeats_asset_time ON asset_heartbeats (asset_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS heartbeat_alerts (
    id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('down', 'recovered')),
    previous_status VARCHAR(10) NOT NULL,
    current_status VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    is_resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_alerts_asset ON heartbeat_alerts (asset_id);
CREATE INDEX IF NOT EXISTS idx_heartbeat_alerts_unresolved ON heartbeat_alerts (is_resolved, created_at DESC);
