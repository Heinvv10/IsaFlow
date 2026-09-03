-- 590: give accounting_budgets the uniqueness its upsert always assumed.
--
-- budgetService's ON CONFLICT named (gl_account_id, fiscal_year), a constraint
-- that was never created, so the write path could not have worked even once the
-- column list was right. The correct key is per tenant: two companies may each
-- budget their own account for the same year.
--
-- gl_account_id is nullable on this table, and NULLs never collide in a b-tree
-- unique index, so the index is partial and every ON CONFLICT that targets it
-- must repeat the same predicate.

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_budgets_company_account_year
  ON accounting_budgets (company_id, gl_account_id, fiscal_year)
  WHERE gl_account_id IS NOT NULL;
