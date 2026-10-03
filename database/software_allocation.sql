-- License Allocation & Utilization (License Management): market/client
-- dimensions and per-record user allocation for software_assets.
-- market_name: HMT1 | HMT2 | HPR | HLS | HHP | Functions (IT)
-- client_name: healthcare/enterprise client the license block belongs to
--   (distinct from the legacy `client` procurement column).
-- allocated_user_id: the user holding this license record; NULL = unallocated.
-- User names are always resolved by joining users — never stored as text —
-- so the dashboard reuses the existing directory as its source of truth.

ALTER TABLE software_assets
    ADD COLUMN IF NOT EXISTS market_name VARCHAR(30) NULL,
    ADD COLUMN IF NOT EXISTS client_name VARCHAR(120) NULL,
    ADD COLUMN IF NOT EXISTS allocated_user_id INT NULL REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_software_assets_market ON software_assets (market_name);
CREATE INDEX IF NOT EXISTS idx_software_assets_client_name ON software_assets (client_name);
CREATE INDEX IF NOT EXISTS idx_software_assets_alloc_user ON software_assets (allocated_user_id);
