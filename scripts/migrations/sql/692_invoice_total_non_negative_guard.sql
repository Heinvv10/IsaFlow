-- 692: an invoice may not carry a negative or NaN amount. A credit is a credit note.
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
-- REPAIRING a legacy row: the negative arms carry a "newly negative" test, so
-- a row that is already negative can be cancelled, settled or corrected one
-- column at a time. The NaN arm deliberately does NOT — a row holding NaN may
-- not be half-repaired, because a column still holding NaN poisons every SUM
-- over it. Cancelling or soft-deleting such a row works (none of the three
-- columns is in the SET list); correcting it means setting total_amount,
-- subtotal and tax_amount in ONE statement.
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
  -- NaN first, and on all three money columns. `numeric` accepts 'NaN', and it
  -- is WORSE than a negative total: `NaN < 0` is FALSE so a sign test passes
  -- it, `NaN > 0` is TRUE so it passes the `balance > 0` filter the ageing and
  -- the subledger use — and SUM() over a column holding one is NaN, so a
  -- single row destroys every total for the company rather than hiding one
  -- document. It reaches here the same way a negative does: `Number(...)` on
  -- opaque `templateData` yields NaN for a non-numeric string, and the driver
  -- sends it as 'NaN'. `= 'NaN'::numeric` is the test, because NaN = NaN is
  -- TRUE for numeric in PostgreSQL.
  IF NEW.total_amount = 'NaN'::numeric
     OR NEW.subtotal = 'NaN'::numeric
     OR NEW.tax_amount = 'NaN'::numeric
  THEN
    RAISE EXCEPTION
      'Document % may not carry a NaN amount', COALESCE(NEW.invoice_number, '(no number)')
      USING ERRCODE = 'check_violation',
            HINT = 'A non-numeric amount reached the writer — check the source figure.';
  END IF;

  -- Only a NEWLY negative figure is refused. On UPDATE, a row that is already
  -- negative may be corrected, settled or cancelled; what it may not do is
  -- move to a different negative value.
  IF NEW.total_amount < 0
     AND (TG_OP = 'INSERT' OR OLD.total_amount IS DISTINCT FROM NEW.total_amount)
  THEN
    RAISE EXCEPTION
      'Document % may not carry a negative total (%)',
      COALESCE(NEW.invoice_number, '(no number)'), NEW.total_amount
      USING ERRCODE = 'check_violation',
            HINT = 'A reduction is a credit note: create one against the original document.';
  END IF;

  -- The LEGS, for the same reason and separately. A row can carry
  -- `subtotal -1000, tax -150, total 115`: the total reads clean, so a
  -- total-only guard hides the damage from anyone checking totals, while
  -- SUM(subtotal) and SUM(tax_amount) — the VAT return and every
  -- sales-analysis report — go wrong. It reaches here by the same opaque
  -- `templateData` path: `headerTotals` compares the stored legs against
  -- derived ones only when the template HAS lines, and production carries
  -- line-less templates.
  IF NEW.subtotal < 0
     AND (TG_OP = 'INSERT' OR OLD.subtotal IS DISTINCT FROM NEW.subtotal)
  THEN
    RAISE EXCEPTION
      'Document % may not carry a negative subtotal (%)',
      COALESCE(NEW.invoice_number, '(no number)'), NEW.subtotal
      USING ERRCODE = 'check_violation',
            HINT = 'A reduction is a credit note: create one against the original document.';
  END IF;

  IF NEW.tax_amount < 0
     AND (TG_OP = 'INSERT' OR OLD.tax_amount IS DISTINCT FROM NEW.tax_amount)
  THEN
    RAISE EXCEPTION
      'Document % may not carry a negative tax amount (%)',
      COALESCE(NEW.invoice_number, '(no number)'), NEW.tax_amount
      USING ERRCODE = 'check_violation',
            HINT = 'A negative VAT leg means the rate or the source figure is wrong.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public, pg_temp;

DROP TRIGGER IF EXISTS trg_ci_total_non_negative ON customer_invoices;
CREATE TRIGGER trg_ci_total_non_negative
  BEFORE INSERT OR UPDATE OF total_amount, subtotal, tax_amount ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION accounting_assert_total_non_negative();

DROP TRIGGER IF EXISTS trg_si_total_non_negative ON supplier_invoices;
CREATE TRIGGER trg_si_total_non_negative
  BEFORE INSERT OR UPDATE OF total_amount, subtotal, tax_amount ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION accounting_assert_total_non_negative();
