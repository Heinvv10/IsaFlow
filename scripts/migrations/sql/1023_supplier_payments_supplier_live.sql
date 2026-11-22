-- 1023: a supplier payment is never written onto a soft-deleted (merged-away or deleted) supplier (#1699, breaker of aad49a02, H1).
--
-- 1021's trg_supplier_invoices_supplier_live refuses a BILL onto a soft-deleted supplier. Payments had no such rule: a payment create
-- racing a supplier merge waited at its FK check (KEY SHARE on the supplier) for the merge's FOR UPDATE and then landed on the
-- merged-away source, and a payment form opened before the merge wrote onto it with nothing to stop it. The app now locks the payee
-- live first (core/supplierLiveLock: createSupplierPayment, createBatch via assertBatchAllocatable, the bank-line supplier payment);
-- this trigger is the rule for EVERY writer (old code during a deploy, MCP paths, a direct statement): fail-closed.
--
-- AFTER INSERT OR UPDATE OF supplier_id, FOR EACH ROW, named so it fires after the FK's RI trigger (AFTER ROW triggers of one event
-- fire in name order, C collation; 'RI_ConstraintTrigger_c_<oid>' sorts before any lower-case name), so the FK has already waited for
-- a merge and this statement's fresh snapshot (READ COMMITTED) sees the merge's commit. An UPDATE that leaves supplier_id unchanged
-- (the processing, approval and void of an existing payment of a since-deleted supplier) is let through, as are payments already on a
-- deleted supplier: only a write that puts a payment ONTO one is refused. The merge itself moves payments onto its live survivor.
-- A supplier the caller cannot see (another company's) passes here; the tenant check is the app's (assertSupplierInCompany) and the FK's.
-- SQLSTATE 23503 with constraint supplier_payments_supplier_live, which the app maps to a typed refusal (409,
-- ap/billSupplierLive.PaymentSupplierDeletedError, lib/apiBillSupplierDeleted).
--
-- SECURITY INVOKER (reads suppliers under the caller's row security, as 1021's guard does): no app_definer_reviews row (930).
-- Lock: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on supplier_payments (writes wait for the catalog change, no scan); lock_timeout
-- bounds it, and a held table fails the file with nothing recorded: rerun it. Idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS).
--
-- Rollback (down SQL; roll the code back first):
--   DROP TRIGGER IF EXISTS trg_supplier_payments_supplier_live ON public.supplier_payments;
--   DROP FUNCTION IF EXISTS public.supplier_payments_supplier_live_guard();

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.supplier_payments_supplier_live_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.supplier_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.supplier_id IS NOT DISTINCT FROM OLD.supplier_id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = NEW.supplier_id AND s.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'supplier % has been merged or deleted; a payment cannot be written onto it', NEW.supplier_id
      USING ERRCODE = '23503', CONSTRAINT = 'supplier_payments_supplier_live';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_supplier_payments_supplier_live ON public.supplier_payments;
CREATE TRIGGER trg_supplier_payments_supplier_live AFTER INSERT OR UPDATE OF supplier_id ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.supplier_payments_supplier_live_guard();
ALTER TABLE public.supplier_payments ENABLE ALWAYS TRIGGER trg_supplier_payments_supplier_live;
REVOKE ALL ON FUNCTION public.supplier_payments_supplier_live_guard() FROM PUBLIC;
