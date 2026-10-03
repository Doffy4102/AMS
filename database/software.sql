-- Software assets (License Management -> Software tab).
-- Loaded from the Software Asset CSV; renewal_date is computed at import time:
--   subscription_end_date when present, else purchase_date + renewal cycle
--   (Annual = +1 year, 6 Months = +6 months); NULL for true perpetual.

CREATE TABLE IF NOT EXISTS software_assets (
    id SERIAL PRIMARY KEY,
    sr_no INT NULL,
    sw_name VARCHAR(255) NOT NULL,
    edition_version VARCHAR(120) NULL,
    po_number VARCHAR(60) NULL,
    fams_no VARCHAR(60) NULL,
    license_type VARCHAR(30) NOT NULL DEFAULT 'Perpetual',   -- Perpetual | Subscription
    qty INT NOT NULL DEFAULT 1,
    purchase_date DATE NULL,
    renewal_name VARCHAR(30) NULL,                            -- Annual | 6 Months | Perpetual
    amount NUMERIC(14,2) NULL,                                -- INR
    subscription_start_date DATE NULL,
    subscription_end_date DATE NULL,
    renewal_date DATE NULL,                                   -- computed (see header)
    client_provided BOOLEAN DEFAULT FALSE,
    duty_exempted BOOLEAN DEFAULT FALSE,
    asset_location VARCHAR(120) NULL,
    manufacturer_name VARCHAR(150) NULL,
    remaining_warranty_days INT NULL,
    vendor_name VARCHAR(150) NULL,
    invoice_no VARCHAR(60) NULL,
    client VARCHAR(120) NULL,
    group_name VARCHAR(120) NULL,
    project VARCHAR(120) NULL,
    license_key VARCHAR(120) NULL,
    remarks TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_software_assets_renewal ON software_assets (renewal_date);
CREATE INDEX IF NOT EXISTS idx_software_assets_sub_dates ON software_assets (subscription_start_date, subscription_end_date);
CREATE INDEX IF NOT EXISTS idx_software_assets_name ON software_assets (sw_name);
