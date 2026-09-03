-- ============================================================================
-- 533: how an AFS statement total is computed
--
-- Six lines on every company's taxonomy rendered 0.00, and they were the six a
-- reader looks at first:
--
--   balance_sheet    BS038  Total assets
--   balance_sheet    BS082  Total equity and liabilities
--   income_statement IS452  Net income before interest and taxation
--   income_statement IS471  Net income before taxation
--   income_statement IS480  Net income after taxation
--   income_statement IS485  Accumulated income (loss) end of year
--
-- rollUpTotals summed the siblings that share a total's parent_code. These six
-- have NO parent_code — they are top-level — so it found no siblings and left
-- them at whatever the GL gave them, which is 0 because no GL account maps to a
-- subtotal line. A set of annual financial statements reported Total assets of
-- 0.00.
--
-- The fix needs the taxonomy to SAY how each total is computed, because no
-- positional rule covers both statements:
--
--   * The balance sheet totals are section sums. Total assets is non-current
--     plus current assets; Total equity and liabilities is the three L+E
--     subtotals. Neither includes the other.
--   * The income statement totals are RUNNING. Net income before taxation is
--     net income before interest and taxation plus the interest lines that sit
--     between them; net income after taxation adds the tax lines below that.
--
-- Deriving that from sort_order alone would have to guess which statement
-- accumulates and which does not, so it is recorded instead:
--
--   total_basis = 'children'    sum the non-total children sharing parent_code.
--                               The default, and the existing behaviour, which
--                               is already correct for the seven parented
--                               subtotals.
--   total_basis = 'components'  sum the codes listed in total_components.
--   total_basis = 'running'     the preceding total, plus every non-total line
--                               between it and this one.
--
-- Only lines with is_total = TRUE consult these columns.
-- ============================================================================

ALTER TABLE afs_statement_lines
  ADD COLUMN IF NOT EXISTS total_basis TEXT NOT NULL DEFAULT 'children';

ALTER TABLE afs_statement_lines
  ADD COLUMN IF NOT EXISTS total_components TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'afs_statement_lines_total_basis_check'
  ) THEN
    ALTER TABLE afs_statement_lines
      ADD CONSTRAINT afs_statement_lines_total_basis_check
      CHECK (total_basis IN ('children', 'components', 'running'));
  END IF;
END $$;

-- A 'components' total without components would silently sum nothing and
-- report 0.00 again — the very defect this migration exists to close.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'afs_statement_lines_components_present_check'
  ) THEN
    ALTER TABLE afs_statement_lines
      ADD CONSTRAINT afs_statement_lines_components_present_check
      CHECK (
        total_basis <> 'components'
        OR (total_components IS NOT NULL AND array_length(total_components, 1) > 0)
      );
  END IF;
END $$;

-- ── Backfill the six ────────────────────────────────────────────────────────
--
-- These codes are the shared canonical taxonomy, seeded identically into every
-- company, so there is no subset of tenants to scope to and `company_id IN
-- (...)` would be vacuous. The risk the company_id rule exists to prevent is
-- still real, though: a value-only match on `code` would rewrite a row a
-- tenant had repurposed.
--
-- upsertStatementLine lets any company write any code with any label, and
-- ON CONFLICT (company_id, code) DO UPDATE lets one be redefined in place. So
-- each UPDATE additionally requires the row to STILL BE the canonical line —
-- same label, still top-level, still a total. A tenant who turned BS038 into
-- "Total assets excluding revaluations" under its own parent is left alone
-- rather than silently switched to summing two subtotals they may not use.

UPDATE afs_statement_lines
SET total_basis      = 'components',
    total_components = ARRAY['BS021', 'BS037']
WHERE section     = 'balance_sheet'
  AND code        = 'BS038'
  AND label       = 'Total assets'
  AND parent_code IS NULL
  AND is_total;

UPDATE afs_statement_lines
SET total_basis      = 'components',
    total_components = ARRAY['BS048', 'BS057', 'BS073']
WHERE section     = 'balance_sheet'
  AND code        = 'BS082'
  AND label       = 'Total equity and liabilities'
  AND parent_code IS NULL
  AND is_total;

UPDATE afs_statement_lines
SET total_basis      = 'running',
    total_components = NULL
WHERE section     = 'income_statement'
  AND parent_code IS NULL
  AND is_total
  AND (code, label) IN (
    ('IS452', 'Net income before interest and taxation'),
    ('IS471', 'Net income before taxation'),
    ('IS480', 'Net income after taxation'),
    ('IS485', 'Accumulated income (loss) end of year')
  );
