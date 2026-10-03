-- License Allocation & Utilization: editable per-software unit price used by
-- the Budget & Cost Forecast section. Reuses existing software_assets rows
-- (sw_name, qty, amount) as the seed source — this table becomes the single
-- source of truth for "current price" going forward so admins can correct it
-- without touching historical purchase records.
CREATE TABLE IF NOT EXISTS software_prices (
    id SERIAL PRIMARY KEY,
    sw_name VARCHAR(255) NOT NULL UNIQUE,
    unit_price NUMERIC(14,2) NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    updated_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
