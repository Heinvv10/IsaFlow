-- 695: VAT period locks can be unlocked, and the unlock is kept as history.
--
-- A lock (570) means "this VAT201 is filed; nothing may change its figures",
-- and posting paths now refuse to move a VAT figure inside an active lock. An
-- amended return needs the period open again, so an owner/admin can UNLOCK it
-- with a reason. The row is not deleted: it keeps the figures that were filed
-- and gains who unlocked it, when and why. Only a row with unlocked_at IS NULL
-- locks anything.
--
-- (695, not 694: 694 is already taken by 694_sage_customer_invoice_link.sql on
-- another branch.)
--
-- RLS: 570's tenant_isolation policy is FOR ALL on app_user, so the UPDATE an
-- unlock makes is covered by it unchanged — no policy work here.

ALTER TABLE vat_period_locks ADD COLUMN IF NOT EXISTS unlocked_at   TIMESTAMPTZ;
-- users.id is character varying(255), not uuid — same reason locked_by is TEXT.
ALTER TABLE vat_period_locks ADD COLUMN IF NOT EXISTS unlocked_by   TEXT;
ALTER TABLE vat_period_locks ADD COLUMN IF NOT EXISTS unlock_reason TEXT;

-- All three or none, and never a blank reason or actor: an unlock that does not
-- say who or why is not a record of anything.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vat_period_locks_unlock_ck' AND conrelid = 'vat_period_locks'::regclass
  ) THEN
    ALTER TABLE vat_period_locks ADD CONSTRAINT vat_period_locks_unlock_ck CHECK (
      (unlocked_at IS NULL AND unlocked_by IS NULL AND unlock_reason IS NULL)
      OR (unlocked_at IS NOT NULL
          AND unlocked_by IS NOT NULL AND btrim(unlocked_by) <> ''
          AND unlock_reason IS NOT NULL AND btrim(unlock_reason) <> '')
    );
  END IF;
END $$;

-- One ACTIVE lock per period per company. History rows (unlocked) fall outside
-- the predicate, so the same period can be locked again after an unlock.
-- lockVatPeriod's ON CONFLICT names exactly this arbiter:
--   ON CONFLICT (company_id, period_start, period_end) WHERE unlocked_at IS NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_vat_period_locks_company_period_active
  ON vat_period_locks (company_id, period_start, period_end)
  WHERE unlocked_at IS NULL;

-- Created before this drop so there is no instant without a uniqueness rule.
DROP INDEX IF EXISTS uq_vat_period_locks_company_period;
