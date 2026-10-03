-- New Joinee onboarding: joiners awaiting asset allocation. Each joinee is
-- backed by a users row (status 'pending' until onboarded) so approved
-- allocations flow through the normal assets/accessories assignment paths.
-- The allocation agent drafts a laptop + headphone per designation rules;
-- an engineer reviews/edits, then approval finalizes via the existing
-- checkout/assignment writers (assignments, accessory_assignments, ledger).

CREATE TABLE IF NOT EXISTS new_joinees (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    employee_id VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    location_id INT REFERENCES locations(id) ON DELETE SET NULL,
    employment_status VARCHAR(30) NOT NULL DEFAULT 'Employee'
        CHECK (employment_status IN ('Employee', 'Contractor')),
    date_of_joining DATE NOT NULL DEFAULT CURRENT_DATE,
    designation VARCHAR(100) NOT NULL,

    -- Agent-drafted allocation, pending engineer approval.
    draft_laptop_asset_id INT REFERENCES assets(id) ON DELETE SET NULL,
    draft_headphone_accessory_id INT REFERENCES accessories(id) ON DELETE SET NULL,
    draft_note VARCHAR(255),
    draft_generated_at TIMESTAMP,

    allocation_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (allocation_status IN ('pending', 'draft', 'allocated')),
    allocated_at TIMESTAMP,
    allocated_by INT REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_new_joinees_status ON new_joinees(allocation_status);
