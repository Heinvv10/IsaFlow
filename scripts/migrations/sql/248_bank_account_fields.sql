-- 248: Bank Account extended fields — Sage parity
-- Bank accounts are gl_accounts with account_subtype = 'bank'

ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_branch_name VARCHAR(100);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_branch_code VARCHAR(20);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_account_type VARCHAR(30) DEFAULT 'current'; -- current, savings, credit_card, cash
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_category_id UUID;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_is_default BOOLEAN DEFAULT false;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_default_payment_method VARCHAR(30) DEFAULT 'eft'; -- cash, eft, cheque, credit_card
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_opening_balance NUMERIC(15,2) DEFAULT 0;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_opening_balance_date DATE;

-- Sales reps (already created in 246 but add company_id index)
CREATE INDEX IF NOT EXISTS idx_sales_reps_company ON sales_reps(company_id);
