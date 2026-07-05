-- 503: CIPC annual return submission flag (AFS compliance — CIPC Filing Guide checklist).
-- Lets a company mark its CIPC annual return as filed for the year; the
-- filing guide checklist reads this instead of always reporting "not ready".

ALTER TABLE companies ADD COLUMN IF NOT EXISTS cipc_annual_return_submitted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cipc_annual_return_submitted_at TIMESTAMPTZ;
