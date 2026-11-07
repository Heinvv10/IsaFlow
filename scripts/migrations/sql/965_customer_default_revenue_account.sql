-- 965: a customer's default revenue account (master plan wave 4, PR RA; wave-3 spec decision 3).
--
-- customers.default_revenue_account_id names the revenue account a new invoice line for this customer starts on
-- (the new-invoice page fills it on lines the user has not coded; a user's pick is never overwritten). NULL = none:
-- the line stays on the company's default sales account, exactly as before.
--
-- The FK is COMPOSITE, (default_revenue_account_id, company_id) -> gl_accounts (id, company_id), on the existing unique
-- index gl_accounts_id_company_uq, so the database itself refuses another company's account (a single-column FK is
-- satisfied by any tenant's id, and RI checks bypass RLS). MATCH SIMPLE: a NULL account is not checked. No ON DELETE
-- action (NO ACTION): an account a customer names cannot be hard-deleted from under it; the migration rollback keeps
-- such an account (it already treats a 23503 as "retain"), and the GL account merge's catalogue sweep
-- (accountMergeReferences) counts this column as configuration and refuses to merge the account away until the
-- customer is changed. Which accounts the APP accepts (active, revenue, a leaf, not one that can never carry VAT) is
-- judged by contactRevenueAccount.ts before any write; the FK is the tenant fence underneath it.
--
-- Expand-only: a new nullable column no old code reads or writes, so it is safe beside the live colour and after a
-- code-only rollback. The FK is added NOT VALID and validated here: every existing row is NULL (the column is new), so
-- the VALIDATE scan finds nothing to refuse; customers is small, and the scan takes only SHARE UPDATE EXCLUSIVE on top of
-- the lock the ADD already holds. Safe to re-run: the column and index are IF NOT EXISTS, the constraint is added only
-- when absent, and VALIDATE of a valid constraint is a no-op. Waits at most 5s for a table lock, so a busy table fails
-- the deploy instead of queueing every request behind it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_revenue_account_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'customers_default_revenue_account_fkey' AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE customers ADD CONSTRAINT customers_default_revenue_account_fkey
      FOREIGN KEY (default_revenue_account_id, company_id) REFERENCES gl_accounts (id, company_id) NOT VALID;
  END IF;
END $$;

ALTER TABLE customers VALIDATE CONSTRAINT customers_default_revenue_account_fkey;

CREATE INDEX IF NOT EXISTS idx_customers_default_revenue_account
  ON customers (default_revenue_account_id, company_id) WHERE default_revenue_account_id IS NOT NULL;

COMMENT ON COLUMN customers.default_revenue_account_id IS
  'The revenue account a new invoice line for this customer starts on (migration 965). NULL = none (the company default sales account). Must be this company''s active leaf revenue account that can carry VAT (contactRevenueAccount.ts).';
