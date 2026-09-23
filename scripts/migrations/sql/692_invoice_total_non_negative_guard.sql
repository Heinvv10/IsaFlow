-- 692: an invoice may not carry a negative total. A credit is a credit note.
--
-- R-119. Nothing in the database restricted the sign of `total_amount` on
-- `customer_invoices` or `supplier_invoices` (no CHECK, no trigger — verified
-- against the schema fixture), and a census of all 17 INSERT sites found four
-- writers with no sign guard of their own: recurring-template EXECUTION
-- (core/recurringTemplateLines.ts — `templateData` is opaque JSON off the
-- request body), the AI capture pipeline (ai-invoice-pipeline.ts,
-- capture/[id]/post.ts), time-entry billing (time-entries-invoice.ts, whose
-- `createTimeEntry` does not guard hours/rate either), and the Sage AR import
-- (sageCustomerImportService.ts skips `=== 0`, not `< 0`, where its AP sibling
-- guards `> 0`).
--
-- A negative-total invoice is an ad-hoc credit note living outside
-- `credit_notes`: it is invisible to the ageing and the subledger (both filter
-- `balance > 0`) while its journal, once posted, stands in the GL — a
-- permanent AR/AP-vs-GL difference. `credit_notes` already serves BOTH sides
-- (`type` is 'customer' or 'supplier'), with its own numbering, approval and
-- application, so refusing the shape here costs no capability.
--
-- A TRIGGER, not a CHECK, deliberately. A CHECK is enforced even under
-- `session_replication_role = 'replica'` (measured), which would make a
-- negative row unrepresentable in tests — and rows in exactly that shape are
-- in production now, which is what `effectivePaidExpr`'s sign-aware clamp
-- (R-117) and any later repair have to keep handling. A trigger is suppressed
-- by replica mode, so tests/integration/helpers/preConstraintRow.ts can still
-- seed a pre-guard row, the same way migration 664's NOT VALID FK is seeded.
-- A trigger also carries a HINT naming the remedy, which a CHECK cannot.
--
-- Existing rows are untouched by construction: a trigger fires on writes, so
-- this needs no NOT VALID/VALIDATE dance and cannot fail on historical data.
-- An UPDATE that leaves an already-negative total alone still passes, so the
-- rows the census finds can be edited, reversed or converted without first
-- dropping this guard; only WRITING a negative total is refused.
--
-- Reversible: DROP TRIGGER trg_ci_total_non_negative ON customer_invoices;
--             DROP TRIGGER trg_si_total_non_negative ON supplier_invoices;

CREATE OR REPLACE FUNCTION accounting_assert_total_non_negative()
RETURNS TRIGGER AS $$
BEGIN
  -- Only a NEWLY negative total is refused. On UPDATE, a row whose total was
  -- already negative may be corrected, settled or cancelled; what it may not
  -- do is move to a different negative value.
  IF NEW.total_amount < 0
     AND (TG_OP = 'INSERT' OR OLD.total_amount IS DISTINCT FROM NEW.total_amount)
  THEN
    RAISE EXCEPTION
      'Document % may not carry a negative total (%)',
      COALESCE(NEW.invoice_number, '(no number)'), NEW.total_amount
      USING ERRCODE = 'check_violation',
            HINT = 'A reduction is a credit note: create one against the original document.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public, pg_temp;

DROP TRIGGER IF EXISTS trg_ci_total_non_negative ON customer_invoices;
CREATE TRIGGER trg_ci_total_non_negative
  BEFORE INSERT OR UPDATE OF total_amount ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION accounting_assert_total_non_negative();

DROP TRIGGER IF EXISTS trg_si_total_non_negative ON supplier_invoices;
CREATE TRIGGER trg_si_total_non_negative
  BEFORE INSERT OR UPDATE OF total_amount ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION accounting_assert_total_non_negative();
