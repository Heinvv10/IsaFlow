-- 999b_sars_submissions_one_open_draft.sql (master plan wave 6, HYa)
--
-- One open draft per company, form and period, now held by a unique index too. Migration 971 left the index out on
-- purpose: the colour it replaced still INSERTed drafts plainly. Every colour since wave 5 saves a draft through
-- saveDraftSubmission (sarsComplianceService), which takes the period's advisory lock and updates the open draft when
-- one exists, so the index never fires for it; it refuses only a second draft some other path would add.
--
-- 1. Locks, in the eFiling writer's order (events, then submissions), so the two cannot form a cycle:
--    sars_efiling_events IN SHARE MODE (no event, e.g. a 'sending' one without a correlation id, can commit for an
--    older duplicate between the guard's count and the dedupe), then sars_submissions against writers (SHARE ROW
--    EXCLUSIVE) for the rest of this transaction, so no draft can be added between the dedupe and the index build.
-- 2. Duplicate open drafts: per (company_id, form_type, period_start, period_end) the draft saveDraftSubmission treats
--    as the open one is kept (newest updated_at, then created_at, then highest id: its own ORDER BY); every other
--    draft of that key moves to 'superseded', the status fileReturn already writes, with a note saying why. The move
--    is draft to superseded, which the lifecycle trigger allows. A draft a return version names cannot move (the
--    freeze trigger refuses it) and would stop this migration, and so does a duplicate that may have been sent to SARS
--    (an efiling_correlation_id or any sars_efiling_events row): it is never buried, the migration raises instead. The
--    read-only pre-check in the PR body counts both first. Every tenant's duplicates, deliberately: the rule is the
--    same for all of them. Dev had one pair.
-- 3. The partial unique index.
-- 4. payroll_employees.tax_directive_number is marked deprecated: nothing reads or writes it (the HYa census); it is
--    dropped in wave 7.
--
-- Expand-only: the old colour keeps working on this schema. Rollback: DROP INDEX uq_sars_submissions_one_open_draft;
-- the superseded duplicates stay superseded (they were never the open draft any reader picked).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE public.sars_efiling_events IN SHARE MODE;
LOCK TABLE public.sars_submissions IN SHARE ROW EXCLUSIVE MODE;

-- A duplicate that may have reached SARS (a correlation id, or any eFiling event) is not buried: stop instead.
DO $$
DECLARE
  v_sent pg_catalog.int8;
BEGIN
  WITH ranked AS (
    SELECT id, efiling_correlation_id,
           pg_catalog.row_number() OVER (
             PARTITION BY company_id, form_type, period_start, period_end
             ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
           ) AS rn
    FROM public.sars_submissions
    WHERE status = 'draft'
  )
  SELECT pg_catalog.count(*) INTO v_sent
  FROM ranked r
  WHERE r.rn > 1
    AND (r.efiling_correlation_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.sars_efiling_events e WHERE e.submission_id = r.id));
  IF v_sent > 0 THEN
    RAISE EXCEPTION '999b: % duplicate open SARS draft(s) to supersede may have been sent to SARS (correlation id or eFiling event); resolve them by hand first', v_sent
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

WITH ranked AS (
  SELECT id,
         pg_catalog.row_number() OVER (
           PARTITION BY company_id, form_type, period_start, period_end
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM public.sars_submissions
  WHERE status = 'draft'
)
UPDATE public.sars_submissions s
SET status = 'superseded',
    notes = COALESCE(s.notes || E'\n', '') || 'Superseded by migration 999b: a newer open draft of this period exists.',
    updated_at = pg_catalog.now()
FROM ranked
WHERE s.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sars_submissions_one_open_draft
  ON public.sars_submissions (company_id, form_type, period_start, period_end)
  WHERE status = 'draft';

COMMENT ON COLUMN public.payroll_employees.tax_directive_number IS
  'Deprecated (wave 6): never read or written; drop in wave 7.';
