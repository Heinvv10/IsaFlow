-- 317: Add annual_amount column to accounting_budgets
-- budgetService.ts uses annual_amount for upsert and copy operations,
-- but the column was missing from the original schema.

ALTER TABLE accounting_budgets ADD COLUMN IF NOT EXISTS annual_amount NUMERIC(15,2) DEFAULT 0;
