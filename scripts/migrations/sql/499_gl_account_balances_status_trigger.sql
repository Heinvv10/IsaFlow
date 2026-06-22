-- Migration 499: maintain gl_account_balances on journal-entry status changes
--
-- Root cause
--   gl_account_balances is maintained only by trg_gl_jl_balance_update on
--   gl_journal_lines (mig 465), which early-returns while the parent entry is
--   not 'posted'. The standard posting flow inserts lines while the entry is
--   'draft' (createJournalEntry) and then flips status draft->posted via an
--   UPDATE on gl_journal_entries (postJournalEntry) — a change the line trigger
--   never sees. So the cache is never populated for the main create->post path,
--   and posted->reversed likewise never removes an entry's contribution. The
--   cache drifts (observed: 71 missing + 3 stale + 1 mismatched rows on dev).
--
-- Fix
--   A trigger on gl_journal_entries that, whenever an entry crosses the 'posted'
--   boundary, recomputes the affected accounts' cached balances from the source
--   of truth (posted journal lines) for the entry's fiscal period. Semantics
--   match every report and the existing line trigger: the cache holds the sum of
--   *posted* lines per (gl_account_id, fiscal_period_id). A one-time rebuild at
--   the end heals pre-existing drift.

-- ── Trigger function ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_gl_account_balances_on_status_change()
RETURNS TRIGGER AS $$
DECLARE
  acct UUID;
  per  UUID;
BEGIN
  -- Recompute each account this entry touches from posted lines only, so the
  -- cache equals the reporting truth regardless of which way the status moved
  -- (draft->posted adds the entry's lines, posted->reversed/draft removes them).
  -- This fires once per status change (not once per line), so a full recompute
  -- per affected account stays O(lines-in-account-for-period) and avoids the
  -- O(N^2) blow-up that pushed mig 465's line trigger to incremental deltas.
  --
  -- Recompute under BOTH the new and old fiscal period: if a single UPDATE ever
  -- changes status AND fiscal_period_id together, the entry's contribution is
  -- removed from the old period and rebuilt under the new one (no stale row).
  -- Entries with no fiscal period cannot be cached (keyed on fiscal_period_id),
  -- so NULL periods are skipped.
  --
  -- NOTE: the aggregate SELECT has no GROUP BY, so when no posted lines remain
  -- for (acct, per) it still returns one row of zeros — the ON CONFLICT upsert
  -- then sets the cached balance to 0 rather than leaving a stale value.
  FOR per IN
    SELECT DISTINCT p
    FROM unnest(ARRAY[NEW.fiscal_period_id, OLD.fiscal_period_id]) AS u(p)
    WHERE p IS NOT NULL
  LOOP
    FOR acct IN
      SELECT DISTINCT gl_account_id FROM gl_journal_lines WHERE journal_entry_id = NEW.id
    LOOP
      INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
      SELECT
        acct, per,
        COALESCE(SUM(jl.debit), 0),
        COALESCE(SUM(jl.credit), 0),
        COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = acct
        AND je.fiscal_period_id = per
        AND je.status = 'posted'
      ON CONFLICT (gl_account_id, fiscal_period_id) DO UPDATE SET
        debit_total = EXCLUDED.debit_total,
        credit_total = EXCLUDED.credit_total,
        balance = EXCLUDED.balance,
        updated_at = NOW();
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Trigger ──────────────────────────────────────────────────────────────────
-- Fires only when the status column actually changes value AND the change
-- crosses the 'posted' boundary (entered or left the posted set). The
-- reversal_of_id link-back UPDATE in reverseJournalEntry does not touch status,
-- so it does not fire this trigger.
DROP TRIGGER IF EXISTS trg_gl_je_status_balance ON gl_journal_entries;
CREATE TRIGGER trg_gl_je_status_balance
  AFTER UPDATE OF status ON gl_journal_entries
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    AND (OLD.status = 'posted' OR NEW.status = 'posted')
  )
  EXECUTE FUNCTION refresh_gl_account_balances_on_status_change();

-- ── One-time rebuild ─────────────────────────────────────────────────────────
-- Heal existing drift: entries posted before this trigger existed were never
-- reflected in the cache. Replace the cache wholesale with the posted-line
-- truth. Runs inside the migration runner's transaction (BEGIN/COMMIT), so
-- concurrent readers keep seeing the old rows via MVCC until commit.
DELETE FROM gl_account_balances;
INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
SELECT
  jl.gl_account_id, je.fiscal_period_id,
  COALESCE(SUM(jl.debit), 0),
  COALESCE(SUM(jl.credit), 0),
  COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
WHERE je.status = 'posted'
  AND je.fiscal_period_id IS NOT NULL
GROUP BY jl.gl_account_id, je.fiscal_period_id;
