-- Migration 858: document numbers no longer collide or silently duplicate under
-- concurrent inserts.
-- 2026-10-06 | fix/doc-number-races-20261006
--
-- Eight BEFORE INSERT triggers mint `<P>-<year>-<seq>` as MAX(seq)+1 over the
-- scope's COMMITTED numbers with nothing serialising two writers — the shape 857
-- fixed for journals:
--
--   function                           table                      prefix  year from
--   generate_credit_note_number        credit_notes               CN      credit_date
--   generate_customer_payment_number   customer_payments          CP      payment_date
--   generate_supplier_payment_number   supplier_payments          SP      payment_date
--   generate_consolidation_adj_number  consolidation_adjustments  ELIM    period_start
--   generate_adjustment_number         accounting_adjustments     ADJ     CURRENT_DATE
--   generate_batch_number              supplier_payment_batches   BAT     CURRENT_DATE
--   generate_vat_adjustment_number     vat_adjustments            VA      CURRENT_DATE
--   generate_write_off_number          customer_write_offs        WO      CURRENT_DATE
--
-- Scope is the company, except consolidation adjustments: that table has no
-- company_id and numbers per group_id. Two writers for one scope and year read
-- the same MAX and mint the same number. On the last four tables a unique index
-- on (company_id, number) made the second wait for the first and then fail
-- 23505; the first four had NO index, so the duplicate was stored silently.
--
-- The fix, per function, re-created from its live definition (last defined in
-- 220 / 240) with exactly two changes, as in 857:
--   1. before the MAX, a transaction-scoped advisory lock on (scope, year), so
--      the second writer waits for the first to COMMIT (or roll back) and its
--      MAX — a later statement under READ COMMITTED, so a fresh snapshot — sees
--      the first number and mints the next;
--   2. LPAD(next_seq, 5) truncated past 99999 (`-100000` became `-10000`); the
--      pad is now GREATEST(5, digits). The MAX casts the suffix to INT, so mixed
--      5- and 6-digit suffixes order numerically.
-- And a unique index on the number for the four tables without one (below).
--
-- THE KEY. The seven company-scoped functions take EXACTLY the journal-number
-- lock of 857: pg_advisory_xact_lock(hashtextextended('<company_id>:<year>',
-- 857)). Consolidation adjustments (group-scoped, and no path posts a journal
-- with them) take hashtextextended('<group_id>:<year>', 858).
--   Why one key and not one per function: a separate lock per document type is
--   a lock-ORDER inversion with the journal lock the app reaches every day.
--   allocateTransaction numbers a journal and THEN inserts the customer payment
--   (bankAllocationService:449 then :505; supplier side likewise), while the
--   gateway receipt inserts the payment and THEN numbers its journal
--   (gatewayInvoiceReceiptService:191 then confirmCustomerPayment), as do the
--   MCP contra settlements. With two locks the pair deadlocked (40P01 after 1 s,
--   measured); with one lock it is re-entrant, so the second simply queues. The
--   same holds between document types in one transaction (createBatch: batch
--   then its payments; a bulk allocate: receipts, payments and refunds in input
--   order).
--   The cost: a document insert also queues behind any in-flight transaction
--   that has numbered a journal for that company and year (and vice versa),
--   e.g. a credit-note draft behind a long bulk bank allocation.
--
-- What changes for waits (as in 857):
--   * Same scope + year, two writers: the second used to mint the same number
--     (stored silently, or 23505 where an index existed); it now waits for the
--     first to commit and mints the next.
--   * A burst QUEUES: writer k holds a pool connection behind the k-1 ahead.
--   * The wait is bounded ONLY by the caller's lock_timeout (55P03); the app
--     pool sets none.
--   * The lock is taken in BEFORE INSERT, ahead of the row's FK checks. Known
--     residual (no key choice avoids it; needs the same row at the same
--     moment): a writer that holds the number lock and then waits on a row
--     another transaction holds, while that one then numbers a document or a
--     journal for the same company+year, deadlocks (40P01) where it used to
--     wait and succeed. In-app shapes: customer-payments / supplier-payments
--     POST (lock, then the FK KEY SHARE on the customer / bill) against a
--     bank-allocated refund (contact FOR UPDATE, then the lock) or createBatch
--     (bills FOR UPDATE, then the lock).
--   * Released at COMMIT/ROLLBACK, and at ROLLBACK TO SAVEPOINT when taken
--     inside that savepoint. READ COMMITTED only, as 857.
--
-- Unchanged: inserts that supply the number take no lock (the function returns
-- at IS NOT NULL; the WHEN clause, where there is one, skips it), the owner,
-- SECURITY INVOKER, search_path and grants (CREATE OR REPLACE keeps owner and
-- ACL). App writers of an explicit number into the four newly indexed tables
-- (census 2026-10-06): supplier returns (credit_notes, RTN-, the company's
-- document sequence) — a duplicate now fails 23505, reachable only if that
-- sequence's next_number is set back below an issued number; and
-- scripts/import-sage-britech.ts (customer / supplier payments, Sage's own
-- numbers, ON CONFLICT DO NOTHING) — a duplicate is now skipped instead of
-- stored. Seed scripts write RCP-/PAY-/CRN- numbers. Pre-existing and untouched:
-- four triggers fire on '' too (WHEN ... OR number = '') but the function
-- returns at IS NOT NULL, so an explicit '' is stored as ''.
--
-- Idempotent: CREATE OR REPLACE of the same bodies; the index block skips an
-- index that exists.

-- Every DDL below takes a strong lock on a document table; queued behind a long
-- transaction it would block every write to it, so fail instead (as 853).
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.generate_credit_note_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  cn_year INT;
  next_seq INT;
BEGIN
  IF NEW.credit_note_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  cn_year := EXTRACT(YEAR FROM COALESCE(NEW.credit_date, CURRENT_DATE));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || cn_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(credit_note_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM credit_notes
  WHERE company_id = NEW.company_id
    AND credit_note_number LIKE 'CN-' || cn_year || '-%';
  NEW.credit_note_number := 'CN-' || cn_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_customer_payment_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  pay_year INT;
  next_seq INT;
BEGIN
  IF NEW.payment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  pay_year := EXTRACT(YEAR FROM COALESCE(NEW.payment_date, CURRENT_DATE));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || pay_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(payment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM customer_payments
  WHERE company_id = NEW.company_id
    AND payment_number LIKE 'CP-' || pay_year || '-%';
  NEW.payment_number := 'CP-' || pay_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_supplier_payment_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  pay_year INT;
  next_seq INT;
BEGIN
  IF NEW.payment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  pay_year := EXTRACT(YEAR FROM COALESCE(NEW.payment_date, CURRENT_DATE));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || pay_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(payment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM supplier_payments
  WHERE company_id = NEW.company_id
    AND payment_number LIKE 'SP-' || pay_year || '-%';
  NEW.payment_number := 'SP-' || pay_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_consolidation_adj_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  adj_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  adj_year := EXTRACT(YEAR FROM COALESCE(NEW.period_start, CURRENT_DATE));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.group_id::text || ':' || adj_year, 858));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(adjustment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM consolidation_adjustments
  WHERE group_id = NEW.group_id
    AND adjustment_number LIKE 'ELIM-' || adj_year || '-%';
  NEW.adjustment_number := 'ELIM-' || adj_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_adjustment_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  adj_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  adj_year := EXTRACT(YEAR FROM CURRENT_DATE);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || adj_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(adjustment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM accounting_adjustments
  WHERE company_id = NEW.company_id
    AND adjustment_number LIKE 'ADJ-' || adj_year || '-%';
  NEW.adjustment_number := 'ADJ-' || adj_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_batch_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  bat_year INT;
  next_seq INT;
BEGIN
  IF NEW.batch_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  bat_year := EXTRACT(YEAR FROM CURRENT_DATE);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || bat_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(batch_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM supplier_payment_batches
  WHERE company_id = NEW.company_id
    AND batch_number LIKE 'BAT-' || bat_year || '-%';
  NEW.batch_number := 'BAT-' || bat_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_vat_adjustment_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  va_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  va_year := EXTRACT(YEAR FROM CURRENT_DATE);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || va_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(adjustment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM vat_adjustments
  WHERE company_id = NEW.company_id
    AND adjustment_number LIKE 'VA-' || va_year || '-%';
  NEW.adjustment_number := 'VA-' || va_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_write_off_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  wo_year INT;
  next_seq INT;
BEGIN
  IF NEW.write_off_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  wo_year := EXTRACT(YEAR FROM CURRENT_DATE);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || wo_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(write_off_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM customer_write_offs
  WHERE company_id = NEW.company_id
    AND write_off_number LIKE 'WO-' || wo_year || '-%';
  NEW.write_off_number := 'WO-' || wo_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$function$;

-- ── Unique indexes for the four tables that had none ─────────────────────────
-- On exactly the scope the trigger numbers within. Created only where the table
-- holds no duplicate already; otherwise a NOTICE names the table and the count
-- and the index is skipped, so existing data can never fail this migration.
-- (isaflow_dev, read 2026-10-06: 0 duplicate groups in all four.) The table is
-- locked SHARE before the count, so no writer can add a duplicate between the
-- count and the build. NULL numbers never conflict in a unique index, so the
-- index is not partial.
DO $$
DECLARE
  t RECORD;
  dup BIGINT;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('credit_notes',              'company_id', 'credit_note_number', 'uq_credit_notes_company_number'),
    ('customer_payments',         'company_id', 'payment_number',     'uq_customer_payments_company_number'),
    ('supplier_payments',         'company_id', 'payment_number',     'uq_supplier_payments_company_number'),
    ('consolidation_adjustments', 'group_id',   'adjustment_number',  'uq_consol_adj_group_number')
  ) AS v(tbl, scope_col, num_col, idx)
  LOOP
    CONTINUE WHEN to_regclass('public.' || t.idx) IS NOT NULL;
    EXECUTE format('LOCK TABLE public.%I IN SHARE MODE', t.tbl);
    EXECUTE format(
      'SELECT count(*) FROM (SELECT 1 FROM public.%1$I WHERE %3$I IS NOT NULL GROUP BY %2$I, %3$I HAVING count(*) > 1) d',
      t.tbl, t.scope_col, t.num_col) INTO dup;
    IF dup = 0 THEN
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (%I, %I)', t.idx, t.tbl, t.scope_col, t.num_col);
    ELSE
      RAISE NOTICE '858: % has % duplicate (%, %) group(s); % NOT created; dedupe, then create it by hand (858_document_number_advisory_locks.sql)',
        t.tbl, dup, t.scope_col, t.num_col, t.idx;
    END IF;
  END LOOP;
END $$;
