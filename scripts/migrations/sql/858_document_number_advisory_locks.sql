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
--   generate_adjustment_number         accounting_adjustments     ADJ     adjustment_date *
--   generate_batch_number              supplier_payment_batches   BAT     batch_date *
--   generate_vat_adjustment_number     vat_adjustments            VA      adjustment_date *
--   generate_write_off_number          customer_write_offs        WO      write_off_date *
--   (* was CURRENT_DATE until this migration; COALESCE(<date>, CURRENT_DATE).)
--
-- Scope is the company, except consolidation adjustments: no company_id, they
-- number per group_id. Two writers for one scope and year read the same MAX and
-- mint the same number. Where a unique index on the number existed (ADJ, BAT,
-- VA, WO) the second then failed 23505; elsewhere the duplicate was stored
-- silently. Migrations 859-861 and 863 add the missing indexes, one per file
-- (862 is taken by another branch).
--
-- Each function is re-created from its live definition (last defined in 220 /
-- 240) with these changes and no others:
--   1. before the MAX, pg_advisory_xact_lock on (scope, year): the second writer
--      waits for the first to COMMIT (or roll back), and its MAX — a later
--      statement under READ COMMITTED, so a fresh snapshot — sees the first
--      number and mints the next;
--   2. LPAD(next_seq, 5) truncated past 99999 (`-100000` became `-10000`); the
--      pad is now GREATEST(5, digits). The MAX casts the suffix to INT, so mixed
--      5- and 6-digit suffixes order numerically;
--   3. SET lock_timeout = '5s' on the function (below);
--   4. ADJ / BAT / VA / WO take the year from the document's own date, as the
--      other four (and journals) do. A back-dated batch or adjustment is now
--      numbered in its date's year (lead's call, 2026-10-06). Without this a
--      batch back-dated into last year took this year's key for its number and
--      last year's for its payments, and deadlocked against a bulk allocation
--      crossing the year end (brk-docnum A1, measured).
--
-- THE KEY. The seven company-scoped functions take EXACTLY the journal-number
-- lock of 857: hashtextextended('<company_id>:<year>', 857). Consolidation
-- adjustments (no path posts a journal with them) take
-- hashtextextended('<group_id>:<year>', 858). One key, not one per document
-- type: allocateTransaction numbers a journal and THEN the receipt / supplier
-- payment / refund (bankAllocationService:449, then :505 / :551 / :596), while
-- the gateway receipt and the MCP contra number the payment and THEN its
-- journal. With a lock per type that pair deadlocked (40P01, measured,
-- tests/integration/docnum-journal-order.int.test.ts); with one key it is
-- re-entrant and the second simply queues. The same holds for two document
-- types in one transaction (createBatch: batch, then its payments).
--
-- THE BOUND (sec-docnum F1). Every numbering function, and 857's
-- generate_journal_entry_number (ALTER below), runs with lock_timeout = 5s for
-- the duration of the call. Without it a numbering insert waited, with no
-- limit but production's 95 s statement_timeout, behind ANY open transaction
-- that had numbered a journal or a document for that company and year, holding
-- its pool connection — one company could fill the shared auth pool (measured
-- by sec-docnum). Two effects, both deliberate:
--   * a caller with no lock_timeout (the app pool sets none) now gets 55P03
--     after 5 s instead of waiting; routes that map lock timeouts answer 503 +
--     Retry-After (D11, src/lib/lockTimeout.ts);
--   * a caller with a TIGHTER lock_timeout gets 5 s inside the function: a
--     function-level SET replaces the session value for the call and restores it
--     on exit.
--
-- What changes for waits:
--   * Same scope + year, two writers: the second waits (at most 5 s) and mints
--     the next number.
--   * A pure document insert (a credit-note, VAT-adjustment or write-off draft)
--     now queues behind any in-flight transaction that has numbered a journal
--     for that company and year, and vice versa — journal posts already queued
--     the same way among themselves since 857.
--   * A burst queues: writer k waits for the k-1 ahead of it, up to 5 s.
--   * Released at COMMIT/ROLLBACK, and at ROLLBACK TO SAVEPOINT when taken inside
--     that savepoint. READ COMMITTED only, as 857.
--
-- Year boundary: the key includes the year, so a transaction that numbers in two
-- years holds two keys. Census 2026-10-06: every transaction that numbers a
-- document AND a journal dates them alike (bank allocation: the bank line's
-- date; gateway receipt and contra: the payment date; provisional settlement:
-- its reclass date; supplier credit note create-and-post: the credit date;
-- createBatch: batch_date for the batch and its payments, after change 4).
-- Known residual, pre-existing since 857 (brk-docnum F3, measured): two bulk
-- allocations over lines of two years, posting them in opposite year order
-- (writeBankBulkAllocate sorts by bank line id, so the order follows the uuids),
-- deadlock on the journal key itself.
--
-- Known residual: a ROW lock against the number lock. The number lock is taken
-- in BEFORE INSERT, ahead of the row's FK checks, so a transaction that holds K
-- (this company+year's key) and then needs a row deadlocks (40P01) against one
-- that holds that row and then needs K. Needs the same row at the same moment.
-- Shapes that can cycle (code reading 2026-10-06; brk-docnum A2 measured the
-- first):
--   * customer invoice. K then the invoice: createCustomerPayment (customer-
--     payments POST, MCP contra; KEY SHARE through the allocation FK), the
--     gateway receipt (gatewayReceiptAllocation FOR UPDATE), a bank-allocated
--     receipt auto-applying (autoApplyCustomerReceipt, FOR UPDATE on the
--     customer's open invoices). The invoice then K: cancelCustomerInvoice
--     (FOR UPDATE, then reverseJournalEntry). New with 858 for the first two;
--     the bank auto-apply pair has existed since 857.
--   * contact (customer / supplier). K then the contact (FK KEY SHARE on
--     client_id / supplier_id): every receipt, supplier payment and credit-note
--     insert. The contact then K: a bank-allocated refund (lockContactForRefund
--     FOR UPDATE, paymentLock.ts, then its journal). New with 858 except for
--     the bank-allocated receipt / payment, which already numbered a journal
--     first under 857.
--   * supplier bill. The bills then K: createBatch (assertBatchAllocatable
--     FOR UPDATE, then the batch number) and the supplier-payments POST
--     (fetchBillCandidates FOR UPDATE, then the payment number). K then the
--     bills: a bank-allocated supplier payment (journal, then supplierAutoAllocate
--     / planSupplierPaymentApplication FOR UPDATE). New with 858: createBatch and
--     the POST took no number lock before. (createBatch against the POST does
--     NOT cycle: both lock the bills first, in id order.)
-- Before 858 the first transaction of each new pair just waited.
--
-- Unchanged: inserts that supply the number take no lock (the function returns
-- at IS NOT NULL; the WHEN clause, where there is one, skips it); owner,
-- SECURITY INVOKER, search_path and grants (CREATE OR REPLACE keeps owner and
-- ACL; proconfig now carries lock_timeout). Pre-existing and untouched: four
-- triggers fire on '' too (WHEN ... OR number = '') but the function returns at
-- IS NOT NULL, so an explicit '' is stored as ''.
--
-- Idempotent: CREATE OR REPLACE of the same bodies; ALTER FUNCTION ... SET of
-- the same value.

CREATE OR REPLACE FUNCTION public.generate_credit_note_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET lock_timeout TO '5s'
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
 SET lock_timeout TO '5s'
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
 SET lock_timeout TO '5s'
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
 SET lock_timeout TO '5s'
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
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  adj_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  adj_year := EXTRACT(YEAR FROM COALESCE(NEW.adjustment_date, CURRENT_DATE));
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
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  bat_year INT;
  next_seq INT;
BEGIN
  IF NEW.batch_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  bat_year := EXTRACT(YEAR FROM COALESCE(NEW.batch_date, CURRENT_DATE));
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
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  va_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  va_year := EXTRACT(YEAR FROM COALESCE(NEW.adjustment_date, CURRENT_DATE));
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
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  wo_year INT;
  next_seq INT;
BEGIN
  IF NEW.write_off_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  wo_year := EXTRACT(YEAR FROM COALESCE(NEW.write_off_date, CURRENT_DATE));
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

-- 857's journal-number function: same bound (see THE BOUND above).
ALTER FUNCTION public.generate_journal_entry_number() SET lock_timeout = '5s';
