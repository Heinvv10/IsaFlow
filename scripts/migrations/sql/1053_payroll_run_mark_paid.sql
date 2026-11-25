-- 1053: "Mark paid" for a pay run (wave 7 MP, W27; Hein rulings 4 and 16, 2026-11-25). Expand-only.
--
-- WHAT
--   payroll_run_headers gains the run's payment record: paid_at (when it was recorded), paid_by (who), paid_reference
--   (the bank payment reference typed by the person, 1-64 characters after trimming) and paid_on (the payment date).
--   'paid' was in the status CHECK since 382 and refused by reopen, but nothing wrote it; the new route
--   POST /api/payroll/runs/[id]/mark-paid (payrollRunMarkPaid.ts) does, either from a confirmed salary bank file or
--   from a typed reference + date.
--   CHECKs, each NOT VALID, then the backfill, then VALIDATE:
--     payroll_run_headers_paid_reference_len  char_length(btrim(paid_reference)) BETWEEN 1 AND 64 (NULL passes);
--     payroll_run_headers_paid_at_set         (status = 'paid') = (paid_at IS NOT NULL): every paid run says when.
--   Trigger trg_payroll_run_headers_paid_evidence (SECURITY INVOKER, ENABLE ALWAYS), the write-once rule:
--     entering 'paid' (INSERT as paid, or UPDATE from another status): paid_at is the clock (clock_timestamp()), never
--       what the writer sent, and paid_by is the session user (auth.uid(), as 999h stamps bank files) when there is one;
--       paid_reference and paid_on are kept as written (the CHECK bounds the reference);
--     staying 'paid': the four columns never change (23514);
--     any other status: the four are NULL. A writer that sends any of them for a run that is not paid is refused
--       (23514); a run LEAVING paid has them cleared with it, which keeps the Demo reseed's reopen of its generated paid
--       runs (scripts/lib/demoReseed/payrollFinal.ts reopenFinalRuns: status -> calculated) and its re-finalise working,
--       old colour and new, with no change to that script.
--   A trusted restore (payroll_run_trusted_restore, 999x: superuser, migration_admin or the table owner) keeps a paid_at
--   it writes, and may correct a paid run's record; nobody else may.
--
-- WHAT THIS DOES NOT DO (residual, named)
--   The database does not refuse a run LEAVING 'paid'. The app does (reopenPayrollRun: 409 RUN_PAID; approve, calculate
--   and the grid refuse a locked status), but app_user holds table-level UPDATE on payroll_run_headers, so a raw
--   UPDATE of status by a session already holding app_user can still move it, as it can move an approved run today.
--   Status writes move behind reviewed SECURITY DEFINERs in wave-7 AD1 and the direct grant goes in AD2 (spec section 4).
--   The Demo reseed needs that exit (above). auth.uid() reads request.jwt.claims, which an app_user session can set
--   itself (the 999h residual): paid_by records who withAuth says acted, not a SQL-level control.
--
-- OLD COLOUR (the previous release against this schema)
--   It never names the four columns and never writes 'paid' through the app (reopen refuses it, nothing sets it).
--   INSERTs of headers (draft) leave them NULL and pass both CHECKs. Its approve / calculate / reopen / cancel UPDATEs
--   never move a run into or out of 'paid', so the trigger only checks that nothing was sent. Its reads use SELECT *
--   or name columns: the extra columns are ignored. Its Demo reseed moves generated runs to 'paid' (paid_at stamped by
--   the trigger) and back to 'calculated' (cleared by the trigger): unchanged. A raw UPDATE to 'paid' in an old test
--   or script is stamped, so it passes the CHECK.
--
-- BACKFILL (stated): a legacy 'paid' row (prod: the Demo reseed's generated runs; dev: none) gets paid_at = updated_at,
--   paid_by / paid_reference / paid_on NULL (the record is unknown). Dev carries a paid_at column from the unmerged 385
--   (999f's note); any value on a row that is not paid is cleared. The coordinator counts prod's 'paid' rows read-only
--   before queueing (SELECT count(*) FROM payroll_run_headers WHERE status = 'paid').
--
-- LOCKS. ADD COLUMN without a default is catalogue-only (ACCESS EXCLUSIVE for an instant); ADD CONSTRAINT ... NOT VALID
--   likewise; the backfill UPDATEs only paid rows; VALIDATE takes SHARE UPDATE EXCLUSIVE and scans the table (small).
--   All bounded by lock_timeout.
--
-- Rollback (down SQL; roll the code back first: no older code writes or reads these columns):
--   DROP TRIGGER IF EXISTS trg_payroll_run_headers_paid_evidence ON public.payroll_run_headers;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_paid_evidence();
--   ALTER TABLE public.payroll_run_headers DROP CONSTRAINT IF EXISTS payroll_run_headers_paid_at_set,
--     DROP CONSTRAINT IF EXISTS payroll_run_headers_paid_reference_len;
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS paid_by, DROP COLUMN IF EXISTS paid_reference,
--     DROP COLUMN IF EXISTS paid_on;   -- paid_at: drop it too everywhere but dev (dev had it before this file)

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payroll_run_headers
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_by text,
  ADD COLUMN IF NOT EXISTS paid_reference text,
  ADD COLUMN IF NOT EXISTS paid_on date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.payroll_run_headers'::pg_catalog.regclass
                    AND conname = 'payroll_run_headers_paid_reference_len') THEN
    ALTER TABLE public.payroll_run_headers ADD CONSTRAINT payroll_run_headers_paid_reference_len
      CHECK (char_length(btrim(paid_reference)) BETWEEN 1 AND 64) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.payroll_run_headers'::pg_catalog.regclass
                    AND conname = 'payroll_run_headers_paid_at_set') THEN
    ALTER TABLE public.payroll_run_headers ADD CONSTRAINT payroll_run_headers_paid_at_set
      CHECK ((status = 'paid') = (paid_at IS NOT NULL)) NOT VALID;
  END IF;
END
$$;

-- The backfill, before the trigger exists (a re-run finds nothing to do: both statements are predicated).
UPDATE public.payroll_run_headers SET paid_at = updated_at WHERE status = 'paid' AND paid_at IS NULL;
UPDATE public.payroll_run_headers SET paid_at = NULL WHERE status <> 'paid' AND paid_at IS NOT NULL;

ALTER TABLE public.payroll_run_headers VALIDATE CONSTRAINT payroll_run_headers_paid_reference_len;
ALTER TABLE public.payroll_run_headers VALIDATE CONSTRAINT payroll_run_headers_paid_at_set;

CREATE OR REPLACE FUNCTION public.payroll_run_headers_paid_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  trusted boolean := public.payroll_run_trusted_restore(TG_RELID);
  was_paid boolean := TG_OP = 'UPDATE' AND OLD.status = 'paid';
  uid text := auth.uid();
BEGIN
  IF NEW.status IS DISTINCT FROM 'paid' THEN
    IF NOT was_paid AND NOT trusted
       AND num_nonnulls(NEW.paid_at, NEW.paid_by, NEW.paid_reference, NEW.paid_on) > 0
       AND (TG_OP = 'INSERT' OR (NEW.paid_at, NEW.paid_by, NEW.paid_reference, NEW.paid_on)
                                IS DISTINCT FROM (OLD.paid_at, OLD.paid_by, OLD.paid_reference, OLD.paid_on)) THEN
      RAISE EXCEPTION 'payroll_run_headers: a payment record (paid_at, paid_by, paid_reference, paid_on) is only written when the run is marked paid'
        USING ERRCODE = '23514';
    END IF;
    NEW.paid_at := NULL;
    NEW.paid_by := NULL;
    NEW.paid_reference := NULL;
    NEW.paid_on := NULL;
    RETURN NEW;
  END IF;
  IF was_paid THEN
    IF NOT trusted AND (NEW.paid_at, NEW.paid_by, NEW.paid_reference, NEW.paid_on)
                       IS DISTINCT FROM (OLD.paid_at, OLD.paid_by, OLD.paid_reference, OLD.paid_on) THEN
      RAISE EXCEPTION 'payroll_run_headers: a paid run''s payment record (paid_at, paid_by, paid_reference, paid_on) is written once'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  NEW.paid_at := CASE WHEN trusted THEN COALESCE(NEW.paid_at, clock_timestamp()) ELSE clock_timestamp() END;
  NEW.paid_by := COALESCE(uid, NEW.paid_by);
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_payroll_run_headers_paid_evidence
  BEFORE INSERT OR UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_paid_evidence();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER trg_payroll_run_headers_paid_evidence;
