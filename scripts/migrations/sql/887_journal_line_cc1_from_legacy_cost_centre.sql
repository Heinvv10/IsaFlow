-- 887: cc1_id is the only CC1 on a journal line (PR #688, Hein 2026-10-10).
--
-- gl_journal_lines carries CC1 twice: cc1_id (migration 285, FK to
-- cost_centres since 882/884) and the legacy cost_center_id (uuid, no FK).
-- tag_journal_lines writes cc1_id only, so every report that also read the
-- legacy column either counted a re-tagged line under its old FNO or, reading
-- COALESCE(cc1_id, cost_center_id), brought back a CC1 the user had cleared.
-- From this release cost_center_id is LEGACY and read by no report: every
-- cost-centre filter, the cc1 grouping, the ledger drill-downs and the GL-line
-- export read cc1_id alone, and createJournalEntry copies a legacy id into
-- cc1_id on every new line (gl/legacyCostCentreMirror.ts). This file does the
-- same for the lines already stored, so no tagged line drops out of a report.
--
--  0. Precondition: every line with cost_center_id set and cc1_id NULL must
--     name a cost centre of the line's OWN company whose cc_type is 'cc1'.
--     Anything else refuses the whole file, naming the first ten lines:
--       - an id of another company, or of no cost centre (the column has no
--         FK): copying it would name a master this company cannot see;
--       - a CC2 or an untyped centre: assertJournalAnalysisDimensions refuses
--         a CC1 that is not cc_type 'cc1' in EVERY mode, reversal included, so
--         such a line would become impossible to reverse.
--     Correct each by hand (tag its cc1_id / cc2_id with tag_journal_lines,
--     or clear cost_center_id), then re-run. isaflow_dev held no legacy-only
--     line on 2026-10-10; production was not checked.
--  1. Backfill: cc1_id = cost_center_id on every such line. A line whose
--     cc1_id is set and differs from cost_center_id (re-tagged since) is NOT
--     touched: cc1_id is authoritative. cost_center_id itself is never
--     changed or dropped here.
--
-- BALANCES. The only trigger on gl_journal_lines is trg_gl_jl_balance_update
-- (update_account_balances, AFTER INSERT/UPDATE/DELETE, per row). For an
-- UPDATE that changes neither gl_account_id, debit nor credit its delta is 0;
-- tag_journal_lines takes the same path on every re-tag. On a disposable
-- fixture (2026-10-10) every gl_account_balances row was identical before and
-- after. One exception, the trigger's own bootstrap: where an affected
-- (account, period) had NO cached row, it creates one holding the true total.
--
-- LOCKS. SHARE ROW EXCLUSIVE on gl_journal_lines, held to COMMIT
-- (apply-migrations.ts runs each file in one transaction), so no line can be
-- written between the check and the backfill; reads keep running. Taken
-- before anything else, so the file holds nothing a writer could be waiting
-- on. A writer that updates gl_account_balances before it inserts journal
-- lines can still deadlock with the backfill's trigger: one side is cancelled
-- (40P01) and, if it is this file, nothing is applied — re-run it. If
-- lock_timeout trips, the same: re-run. The file is idempotent.
--
-- THE DEPLOY WINDOW. Migrations run before the new build is live, so the old
-- code can still write a legacy-only line in the minute between. Re-running
-- the section 1 UPDATE by hand after the deploy picks it up; it is safe to run
-- any number of times.
--
-- Rollback: none needed for correctness (cost_center_id is unchanged). To undo
-- the backfill exactly, a snapshot of the affected ids must be taken first.
SET LOCAL lock_timeout = '5s';

-- ── 0. Precondition: every legacy-only id is a CC1 of the line's company ───
DO $$
DECLARE
  v_n pg_catalog.int8;
  v_ids pg_catalog.text;
BEGIN
  LOCK TABLE public.gl_journal_lines IN SHARE ROW EXCLUSIVE MODE;
  -- FORCE RLS applies to the owner: unless this role bypasses it, the count
  -- would see no rows and pass. With row_security off it raises instead.
  PERFORM pg_catalog.set_config('row_security', 'off', true);
  SELECT pg_catalog.count(*),
         pg_catalog.string_agg(y.id::pg_catalog.text || ' (company ' || y.company_id::pg_catalog.text
                               || ', cost_center_id ' || y.cost_center_id::pg_catalog.text || ': ' || y.why || ')',
                               ', ' ORDER BY y.id) FILTER (WHERE y.rn <= 10)
  INTO v_n, v_ids
  FROM (SELECT x.*, pg_catalog.row_number() OVER (ORDER BY x.id) AS rn FROM (
          SELECT jl.id, jl.company_id, jl.cost_center_id,
                 CASE WHEN c.id IS NULL THEN 'not a cost centre of this company'
                      ELSE 'cc_type ' || COALESCE(c.cc_type, 'NULL') || ', not cc1' END AS why
          FROM public.gl_journal_lines jl
          LEFT JOIN public.cost_centres c ON c.id = jl.cost_center_id AND c.company_id = jl.company_id
          WHERE jl.cost_center_id IS NOT NULL
            AND jl.cc1_id IS NULL
            AND (c.id IS NULL OR c.cc_type IS DISTINCT FROM 'cc1')) x) y;
  IF v_n > 10 THEN
    v_ids := v_ids || ' (+' || (v_n - 10)::pg_catalog.text || ' more)';
  END IF;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'migration 887: % journal line(s) carry a legacy cost_center_id that is not a CC1 of their company — correct each by hand before applying: %', v_n, v_ids
      USING HINT = 'Tag each line''s CC1 / CC2 with tag_journal_lines, or clear its cost_center_id; run the same check on dev and prod before deploying.';
  END IF;
END $$;

-- ── 1. Backfill cc1_id from the legacy column ──────────────────────────────
SELECT pg_catalog.set_config('row_security', 'off', true);
UPDATE public.gl_journal_lines
   SET cc1_id = cost_center_id
 WHERE cc1_id IS NULL
   AND cost_center_id IS NOT NULL;
SELECT pg_catalog.set_config('row_security', 'on', true);
