-- 965: assets.disposal_type also accepts 'scrap' and 'insurance_claim' (Hein, 2026-11-07).
--
-- 361 limited the column to sale/write_off/donation/theft/loss, while the asset page offered 'scrap' (its default)
-- and 'insurance_claim': the dispose route 500'd on them after the ledger row was written. The page and the route now
-- share one list (src/modules/accounting/services/items/assetDisposalTypes.ts), and this widens the CHECK to match it.
--
-- A strict superset of 361's list, so NOT VALID: every existing row already satisfies it, and no scan is needed.
-- Expand-only and safe beside the old code, which then stops 500ing on those two types.
-- Lock: ACCESS EXCLUSIVE on assets until COMMIT, held for the two catalogue changes only; lock_timeout ends the
-- migration first (one transaction, nothing changed): re-run it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_disposal_type_check;
ALTER TABLE assets ADD CONSTRAINT assets_disposal_type_check CHECK (
  disposal_type IN ('sale', 'write_off', 'donation', 'theft', 'loss', 'scrap', 'insurance_claim')
  OR disposal_type IS NULL) NOT VALID;
