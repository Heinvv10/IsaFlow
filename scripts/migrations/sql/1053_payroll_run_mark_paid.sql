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
--       paid_reference and paid_on are kept as written (the CHECK bounds the reference). For everyone but a trusted
--       identity it also needs the run's journal in force (gl_journal_in_force, 1018) and paid_on (review #1911 B5);
--     staying 'paid': the four columns never change (23514);
--     leaving 'paid': refused (23514) for everyone but a trusted identity (review #1911 B4); a trusted one has the four
--       cleared with it. The Demo company is exempt from B4 and B5, as from 999x's history guard (its reseed may run as a
--       role that holds the owner's privileges without being the owner; its money is not real). That is the Demo reseed: it connects as the table owner (postgres, NOSUPERUSER on Supabase) and
--       reopens its generated paid runs (scripts/lib/demoReseed/payrollFinal.ts reopenFinalRuns: status -> calculated),
--       then re-finalises them, old colour and new, with no change to that script;
--     any other status: the four are NULL; a writer that sends any of them for a run that is not paid is refused (23514).
--   A trusted identity (payroll_run_trusted_restore, 999x: superuser, migration_admin or the table owner) is the restore
--   and ops path: it keeps a paid_at it writes and may correct or clear a paid run's record; nobody else may.
--   Also here: 999x's payroll_off_cycle_paid_snapshot no longer takes approved -> paid for a reopen (review #1911 Q1; at
--   the end of this file).
--
-- WHAT THIS DOES NOT DO (residual, named)
--   app_user holds table-level UPDATE on payroll_run_headers, so a session already holding app_user can still move an
--   approved run to paid below the service, if it supplies paid_on and the journal is in force (what the route judges,
--   less the bank-file and date rules); status writes move behind reviewed SECURITY DEFINERs in wave-7 AD1 and the
--   direct grant goes in AD2. auth.uid() reads request.jwt.claims, which an app_user session can set itself (the 999h
--   residual): paid_by records who withAuth says acted, not a SQL-level control.
--
-- OLD COLOUR (the previous release against this schema)
--   It never names the four columns and never writes 'paid' through the app (reopen refuses it, nothing sets it).
--   INSERTs of headers (draft) leave them NULL and pass both CHECKs. Its approve / calculate / reopen / cancel UPDATEs
--   never move a run into or out of 'paid', so the trigger only checks that nothing was sent. Its reads use SELECT *
--   or name columns: the extra columns are ignored. Its Demo reseed moves generated runs to 'paid' (paid_at stamped by
--   the trigger) and back to 'calculated' (cleared by the trigger) as the table owner, a trusted identity: unchanged. A
--   raw UPDATE to 'paid' by a trusted role (an old test or script as the owner or a superuser) is stamped, so it passes
--   the CHECK; as app_user it needs paid_on and the journal in force (B5).
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
--   and re-run 999x's CREATE OR REPLACE FUNCTION public.payroll_off_cycle_paid_snapshot() (its body before this file).

SET LOCAL lock_timeout = '5s';

-- Q3 (review #1911): dev carries a paid_at from the unmerged 385 (999f's note). ADD COLUMN IF NOT EXISTS would accept a
-- column of another type silently, so an existing one of these four must already have the type this file gives it.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s is %s', c.column_name, c.data_type), ', ') INTO bad
    FROM information_schema.columns c
    JOIN (VALUES ('paid_at', 'timestamp with time zone'), ('paid_by', 'text'), ('paid_reference', 'text'), ('paid_on', 'date'))
         AS want(name, type) ON want.name = c.column_name
   WHERE c.table_schema = 'public' AND c.table_name = 'payroll_run_headers' AND c.data_type <> want.type;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1053: payroll_run_headers already has % (expected timestamptz / text / text / date)', bad;
  END IF;
END
$$;

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
  -- The Demo company is exempt from the transition rules (B4, B5) as from 999x's history guard: the reseed may run as a
  -- non-owner (a role holding the owner's privileges, demo-reseed.int.test.ts) and its money is not real. Only a row that
  -- WAS Demo's (review #1911 round 2, D3): a client run moved into Demo in the same UPDATE that marks it paid, then moved
  -- back, would otherwise be paid with no journal and no date.
  demo boolean := NEW.company_id = '00000000-0000-0000-0000-000000000001'::uuid
                  AND (TG_OP = 'INSERT' OR OLD.company_id = '00000000-0000-0000-0000-000000000001'::uuid);
BEGIN
  IF NEW.status IS DISTINCT FROM 'paid' THEN
    -- B4 (review #1911): only a trusted identity takes a run out of paid (the Demo reseed, as the table owner); for
    -- everyone else the record would be lost with no audit row.
    IF was_paid AND NOT trusted AND NOT demo THEN
      RAISE EXCEPTION 'payroll_run_headers: a paid run stays paid (correct it with an off-cycle run)' USING ERRCODE = '23514';
    END IF;
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
  -- B5 (review #1911): entering paid, for everyone but a trusted identity, needs the run's journal in force (1018's
  -- gl_journal_in_force, read as the caller) and a payment date, as markPayrollRunPaid judges before it writes.
  IF NOT trusted AND NOT demo THEN
    IF NEW.journal_entry_id IS NULL OR NOT public.gl_journal_in_force(NEW.journal_entry_id) THEN
      RAISE EXCEPTION 'payroll_run_headers: a run is marked paid only with its payroll journal in force' USING ERRCODE = '23514';
    END IF;
    IF NEW.paid_on IS NULL THEN
      RAISE EXCEPTION 'payroll_run_headers: a run is marked paid only with its payment date (paid_on)' USING ERRCODE = '23514';
    END IF;
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

-- Q1 (review #1911): 999x's payroll_off_cycle_paid_snapshot took an approved off-cycle run leaving 'approved' as a reopen and
-- re-snapshotted off_cycle_paid_gross. approved -> paid is not a reopen: the snapshot is left as it was. The body below is
-- 999x's (identical to dev's live definition, checked 2026-11-25) with only that condition added, in both places it
-- tests a reopen. SECURITY INVOKER, owner unchanged: no app_definer_reviews (930) row. OLD COLOUR: the previous release
-- never moves a run to 'paid', so it meets the same function as before.
CREATE OR REPLACE FUNCTION public.payroll_off_cycle_paid_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  trusted boolean := public.payroll_run_trusted_restore(TG_RELID);
BEGIN
  -- Every role but a trusted ops identity (payroll_run_trusted_restore, review #1679 ops M, fail closed): that one
  -- restores or edits the columns as written; only a reopen (approved -> not approved) still snapshots for it.
  IF trusted
     AND NOT (TG_OP = 'UPDATE' AND OLD.run_kind = 'off_cycle' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved'
              AND NEW.status IS DISTINCT FROM 'paid' -- 1053: approved -> paid is not a reopen
              AND NEW.off_cycle_paid_gross IS NOT DISTINCT FROM OLD.off_cycle_paid_gross) THEN
    RETURN NEW;
  END IF;
  -- For every role but a trusted identity (a restore keeps what it writes), the facts the snapshot below reads are the
  -- trigger's own, never the statement's (review #1679 M5 security S1, S2; blind review H1, M1):
  --  * run_kind and off_cycle_reason are fixed at INSERT (a flip to 'regular' would step around these rules);
  --  * off_cycle_payday_at is never written by the statement (any run kind): NULL at INSERT, then frozen at an
  --    off-cycle run's first approval from its pay date BEFORE that statement (OLD.run_date; the start of the next day,
  --    SAST), and kept as it was after;
  --  * an off-cycle run's pay date is fixed from its first approval on: no change while or once approved (a frozen payday
  --    or an approval history), nor in the statement that approves it;
  --  * approved_at is the clock (clock_timestamp()) when an off-cycle run moves into approved or paid, or when an
  --    approved run with none is approved again (approvePayrollRun's stranded case); otherwise it stays as it was while
  --    approved, and is nil while not approved;
  --  * fail closed: an off-cycle run approved before (an approval history) with no frozen payday is neither approved nor
  --    reopened (its payday was lost below the service; restore it as a trusted identity), and one with no pay date is
  --    not approved at all.
  IF NOT trusted THEN
    IF TG_OP = 'UPDATE' AND (NEW.run_kind IS DISTINCT FROM OLD.run_kind OR NEW.off_cycle_reason IS DISTINCT FROM OLD.off_cycle_reason) THEN
      RAISE EXCEPTION 'payroll_run_headers: a pay run''s kind and off-cycle reason are fixed when it is created'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.off_cycle_payday_at := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.off_cycle_payday_at END;
    IF NEW.run_kind = 'off_cycle' THEN
      IF TG_OP = 'INSERT' THEN
        NEW.approved_at := NULL;
      ELSE
        IF NEW.run_date IS DISTINCT FROM OLD.run_date
           AND (OLD.off_cycle_payday_at IS NOT NULL OR OLD.status IN ('approved', 'paid') OR NEW.status IN ('approved', 'paid')
                OR (OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history))) THEN
          RAISE EXCEPTION 'payroll_run_headers: an off-cycle run''s pay date is fixed once it is approved'
            USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.off_cycle_payday_at IS NULL AND OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history)
           AND (OLD.status IN ('approved', 'paid')) IS DISTINCT FROM (NEW.status IN ('approved', 'paid')) THEN
          RAISE EXCEPTION 'payroll_run_headers: this off-cycle run was approved before but has no recorded payday, so it is not approved or reopened'
            USING ERRCODE = 'check_violation';
        END IF;
        -- No pay date, no payday to freeze: such a run is never approved (re-review L2: it would reopen uncapped).
        IF NEW.status IN ('approved', 'paid') AND OLD.status NOT IN ('approved', 'paid') AND (OLD.run_date IS NULL OR NEW.run_date IS NULL) THEN
          RAISE EXCEPTION 'payroll_run_headers: an off-cycle run with no pay date is not approved' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status IN ('approved', 'paid') THEN
          NEW.approved_at := CASE WHEN OLD.status NOT IN ('approved', 'paid') OR OLD.approved_at IS NULL
                                  THEN pg_catalog.clock_timestamp() ELSE OLD.approved_at END;
          IF OLD.off_cycle_payday_at IS NULL AND OLD.status NOT IN ('approved', 'paid') THEN
            NEW.off_cycle_payday_at := ((OLD.run_date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg');
          END IF;
        ELSE
          NEW.approved_at := NULL;
        END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.off_cycle_paid_gross := NULL;
    RETURN NEW;
  END IF;
  -- 1053 (wave 7 MP): marking an approved run paid (approved -> paid) is not a reopen: the snapshot stays as it was.
  IF OLD.run_kind = 'off_cycle' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved'
     AND NEW.status IS DISTINCT FROM 'paid' THEN
    -- The gross approved for PAYMENT as of payday (review #1679 codex M5). payday ends at off_cycle_payday_at: the start
    -- of the day after the pay date, South African time, as at the first approval (a run is paid once its pay date has
    -- passed, payrollOffCycleCorrection).
    --  * Reopened from an approval given on or before payday (so every reopen before payday, and the first one after it:
    --    the lines that were paid): the snapshot is the lines now, replacing any earlier one (a pre-payday correction
    --    stands). Both times are the trigger's own (above): approved_at the clock's, payday frozen at the first approval.
    --  * Reopened after payday from an approval given after it (a correction of a paid run): never rises (review
    --    #1679b): per employee the LEAST of the snapshot and the lines; an employee absent from it stays nil. With no
    --    snapshot but an approval history it was lost below the service (review #1679d): every employee at nil, as
    --    payrollOffCycleCorrection.paidCaps fails closed.
    SELECT pg_catalog.jsonb_object_agg(s.employee_id::text,
             CASE WHEN OLD.approved_at <= OLD.off_cycle_payday_at THEN s.gross
                  WHEN OLD.off_cycle_paid_gross IS NULL
                       AND OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history) THEN 0
                  WHEN OLD.off_cycle_paid_gross IS NULL THEN s.gross
                  ELSE LEAST(s.gross, COALESCE((OLD.off_cycle_paid_gross ->> s.employee_id::text)::numeric, 0)) END)
      INTO NEW.off_cycle_paid_gross
      FROM (SELECT l.employee_id, pg_catalog.sum(l.gross_pay) AS gross
              FROM public.payroll_run_lines l WHERE l.run_id = OLD.id GROUP BY l.employee_id) s;
    -- No frozen payday or no approval time (NULL): the replacing branch is false (fail closed).
    -- No lines (a run reopened with none): the existing snapshot stands.
    NEW.off_cycle_paid_gross := COALESCE(NEW.off_cycle_paid_gross, OLD.off_cycle_paid_gross);
  ELSE
    NEW.off_cycle_paid_gross := OLD.off_cycle_paid_gross;
  END IF;
  RETURN NEW;
END
$$;
