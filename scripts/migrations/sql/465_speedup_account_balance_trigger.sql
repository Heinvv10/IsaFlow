-- Migration 465: speed up the gl_journal_lines balance trigger
--
-- Root cause:
-- `update_account_balances()` (defined in migration 200) re-aggregates ALL
-- journal lines for the affected account on every INSERT/UPDATE/DELETE row.
-- For tenants with thousands of lines per account (e.g. a busy bank account
-- with 3,000+ allocated txns), this turns a single JE reversal into a
-- minutes-long operation that exceeds the Cloudflare 100s edge timeout.
--
-- Fix:
-- Replace the SUM-from-zero recompute with an incremental delta update.
-- Only re-aggregates if the cached row is missing (cold start). For the
-- common path (row exists), it just adds the changed line's debit/credit
-- delta. Result: O(1) per affected line vs O(N) before.
--
-- Same trigger name, same semantics. Behaviour identical to the old version
-- modulo a one-time recompute when the cached row is bootstrapped.

CREATE OR REPLACE FUNCTION update_account_balances()
RETURNS TRIGGER AS $$
DECLARE
  entry_status VARCHAR(20);
  period_id UUID;
  acct_id UUID;
  d_delta NUMERIC(15,2) := 0;
  c_delta NUMERIC(15,2) := 0;
BEGIN
  -- Get the entry status and period
  SELECT status, fiscal_period_id INTO entry_status, period_id
  FROM gl_journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF entry_status != 'posted' OR period_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  acct_id := COALESCE(NEW.gl_account_id, OLD.gl_account_id);

  -- Compute delta: NEW adds, OLD subtracts.
  IF TG_OP = 'INSERT' THEN
    d_delta := COALESCE(NEW.debit, 0);
    c_delta := COALESCE(NEW.credit, 0);
  ELSIF TG_OP = 'DELETE' THEN
    d_delta := -COALESCE(OLD.debit, 0);
    c_delta := -COALESCE(OLD.credit, 0);
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only fire delta if amounts or account changed
    IF NEW.gl_account_id != OLD.gl_account_id THEN
      -- Account changed: subtract from old, add to new (handled below by recursion is risky;
      -- safer to fall back to full recompute for the rare cross-account move)
      INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
      SELECT
        OLD.gl_account_id, period_id,
        COALESCE(SUM(jl.debit), 0),
        COALESCE(SUM(jl.credit), 0),
        COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = OLD.gl_account_id
        AND je.fiscal_period_id = period_id
        AND je.status = 'posted'
      ON CONFLICT (gl_account_id, fiscal_period_id) DO UPDATE SET
        debit_total = EXCLUDED.debit_total,
        credit_total = EXCLUDED.credit_total,
        balance = EXCLUDED.balance,
        updated_at = NOW();
      d_delta := COALESCE(NEW.debit, 0);
      c_delta := COALESCE(NEW.credit, 0);
    ELSE
      d_delta := COALESCE(NEW.debit, 0) - COALESCE(OLD.debit, 0);
      c_delta := COALESCE(NEW.credit, 0) - COALESCE(OLD.credit, 0);
    END IF;
  END IF;

  -- Try incremental upsert. If the cached row is missing, do a one-time full
  -- recompute so the cache bootstraps correctly.
  IF NOT EXISTS (
    SELECT 1 FROM gl_account_balances
    WHERE gl_account_id = acct_id AND fiscal_period_id = period_id
  ) THEN
    INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
    SELECT
      acct_id, period_id,
      COALESCE(SUM(jl.debit), 0),
      COALESCE(SUM(jl.credit), 0),
      COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.gl_account_id = acct_id
      AND je.fiscal_period_id = period_id
      AND je.status = 'posted'
    ON CONFLICT (gl_account_id, fiscal_period_id) DO UPDATE SET
      debit_total = EXCLUDED.debit_total,
      credit_total = EXCLUDED.credit_total,
      balance = EXCLUDED.balance,
      updated_at = NOW();
  ELSE
    -- Incremental delta update — O(1)
    UPDATE gl_account_balances
    SET debit_total = debit_total + d_delta,
        credit_total = credit_total + c_delta,
        balance = (debit_total + d_delta) - (credit_total + c_delta),
        updated_at = NOW()
    WHERE gl_account_id = acct_id AND fiscal_period_id = period_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
